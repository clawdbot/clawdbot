// Subagent registry steer-restart tests cover replacing child runs after steer
// commands while preserving lifecycle hooks and completion delivery.

import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";

const noop = () => {};
let lifecycleHandler:
  | ((evt: {
      stream?: string;
      runId: string;
      data?: {
        phase?: string;
        startedAt?: number;
        endedAt?: number;
        aborted?: boolean;
        error?: string;
        stopReason?: string;
      };
    }) => void)
  | undefined;

const sessionStore = vi.hoisted(
  () =>
    new Proxy<Record<string, { sessionId: string; lifecycleRevision: string; updatedAt: number }>>(
      {},
      {
        get(target, prop, receiver) {
          if (typeof prop !== "string" || prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return {
            sessionId: `sess-${prop}`,
            lifecycleRevision: `revision-${prop}`,
            updatedAt: 1,
          };
        },
      },
    ),
);

vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent.wait") {
      return { status: "pending" };
    }
    return {};
  }),
}));

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("../../../config/sessions.js", () => {
  return {
    loadSessionStore: vi.fn(() => sessionStore),
    resolveAgentIdFromSessionKey: (key: string) => {
      const match = key.match(/^agent:([^:]+)/);
      return match?.[1] ?? "main";
    },
    resolveMainSessionKey: () => "agent:main:main",
    resolveSessionStorePathCore: () => "/tmp/test-store",
    updateSessionStore: vi.fn(),
  };
});

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  loadSessionEntry: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  loadSessionEntryReadOnly: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  patchSessionEntryCore: async () => null,
}));

const announceSpy = vi.fn(
  async (_params: unknown): Promise<"delivered" | "retryable"> => "delivered",
);
const runSubagentEndedHookMock = vi.fn(async (_eventValue?: unknown, _ctx?: unknown) => {});
const emitSessionLifecycleEventMock = vi.hoisted(() => vi.fn());
const removeInternalSessionEffectsSessionMock = vi.fn(async (_target?: unknown) => {});

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean) {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

const requireRecord = createRequireRecord("record", "expected-label");

function requireSubagentEndedHookCall(runId: string): {
  event: Record<string, unknown>;
  ctx: Record<string, unknown>;
} {
  const call = runSubagentEndedHookMock.mock.calls.find((candidate) => {
    const ctx = candidate[1] as { runId?: string } | undefined;
    return ctx?.runId === runId;
  });
  if (!call) {
    throw new Error(`expected subagent_ended hook call for ${runId}`);
  }
  return {
    event: requireRecord(call[0], `${runId} subagent_ended event`),
    ctx: requireRecord(call[1], `${runId} subagent_ended context`),
  };
}

function requireSessionLifecycleEventCall(label: string): Record<string, unknown> {
  const call = emitSessionLifecycleEventMock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return requireRecord(call[0], label);
}

function requireFirstAnnounceCall(): Record<string, unknown> {
  const call = announceSpy.mock.calls[0];
  if (!call) {
    throw new Error("expected announce call");
  }
  return requireRecord(call[0], "announce params");
}

const noopContextEngine = {
  info: { id: "test-context-engine", name: "Test context engine" },
  ingest: async () => ({ ingested: false }),
  assemble: async () => ({ messages: [], estimatedTokens: 0 }),
  compact: async () => ({ ok: true, compacted: false }),
} satisfies ContextEngine;
vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_ended",
    runSubagentEnded: runSubagentEndedHookMock,
  })),
  getGlobalPluginRegistry: vi.fn(() => null),
  hasGlobalHooks: vi.fn((hookName: string) => hookName === "subagent_ended"),
  initializeGlobalHookRunner: vi.fn(),
  resetGlobalHookRunner: vi.fn(),
}));

vi.mock("../../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: emitSessionLifecycleEventMock,
}));

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: removeInternalSessionEffectsSessionMock,
}));

describe("subagent registry steer restarts", () => {
  let mod: typeof import("./subagent-registry.test-helpers.js");
  type RegisterSubagentRunInput = Parameters<typeof mod.registerSubagentRun>[0];
  const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";
  const MAIN_REQUESTER_DISPLAY_KEY = "main";

  beforeAll(async () => {
    mod = await import("./subagent-registry.test-helpers.js");
  });

  beforeEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(sessionStore)) {
      delete sessionStore[key];
    }
    lifecycleHandler = undefined;
    mod.testing.setDepsForTest({
      ensureContextEnginesInitialized: () => {},
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      resolveContextEngine: async () => noopContextEngine,
    });
    announceSpy.mockReset();
    announceSpy.mockResolvedValue("delivered");
    runSubagentEndedHookMock.mockReset();
    runSubagentEndedHookMock.mockImplementation(async () => {});
    emitSessionLifecycleEventMock.mockReset();
    removeInternalSessionEffectsSessionMock.mockClear();
    mod.resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  const flushAnnounce = async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  };
  const waitForRegistrySideEffect = async (assertion: () => void) => {
    await vi.waitFor(assertion, { interval: 1, timeout: 1_000 });
  };

  const createDeferredAnnounceResolver = (): ((value: "delivered" | "retryable") => void) => {
    // Deferred announce lets tests observe registry state while delivery is
    // still in flight, then release the promise deterministically.
    let resolveAnnounce: ((value: "delivered" | "retryable") => void) | undefined;
    announceSpy.mockImplementationOnce(
      () =>
        new Promise<"delivered" | "retryable">((resolve) => {
          resolveAnnounce = resolve;
        }),
    );
    return (value: "delivered" | "retryable") => {
      if (!resolveAnnounce) {
        throw new Error("Expected subagent announcement resolver to be initialized");
      }
      resolveAnnounce(value);
    };
  };

  const registerCompletionModeRun = (
    runId: string,
    childSessionKey: string,
    task: string,
    options: Partial<Pick<RegisterSubagentRunInput, "spawnMode">> = {},
  ): void => {
    registerRun({
      runId,
      childSessionKey,
      task,
      expectsCompletionMessage: true,
      requesterOrigin: {
        channel: "discord",
        to: "channel:123",
        accountId: "work",
      },
      ...options,
    });
  };

  const registerRun = (
    params: {
      runId: string;
      childSessionKey: string;
      task: string;
      requesterSessionKey?: string;
      requesterDisplayKey?: string;
    } & Partial<
      Pick<RegisterSubagentRunInput, "spawnMode" | "requesterOrigin" | "expectsCompletionMessage">
    >,
  ): void => {
    sessionStore[params.childSessionKey] = {
      sessionId: `sess-${params.childSessionKey}`,
      lifecycleRevision: `revision-${params.childSessionKey}`,
      updatedAt: 1,
    };
    mod.registerSubagentRun({
      runId: params.runId,
      childSessionKey: params.childSessionKey,
      requesterSessionKey: params.requesterSessionKey ?? MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: params.requesterDisplayKey ?? MAIN_REQUESTER_DISPLAY_KEY,
      requesterOrigin: params.requesterOrigin,
      task: params.task,
      cleanup: "keep",
      spawnMode: params.spawnMode,
      expectsCompletionMessage: params.expectsCompletionMessage,
    });
  };

  const listMainRuns = () => mod.listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY);

  const emitLifecycleEnd = (
    runId: string,
    data: {
      startedAt?: number;
      endedAt?: number;
      aborted?: boolean;
      error?: string;
      stopReason?: string;
      terminalReply?: { disposition: "visible"; text: string } | { disposition: "empty" };
    } = {},
  ) => {
    lifecycleHandler?.({
      stream: "lifecycle",
      runId,
      data: {
        phase: "end",
        terminalReply: { disposition: "visible", text: "final completion reply" },
        ...data,
      },
    });
  };

  const replaceRunAfterSteer = (params: {
    previousRunId: string;
    nextRunId: string;
    fallback?: ReturnType<typeof listMainRuns>[number];
    transcriptTarget?: {
      agentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
    };
    task?: string;
  }) => {
    if (params.fallback && listMainRuns().includes(params.fallback)) {
      persistSubagentRunsToDiskOrThrow(subagentRuns, [params.previousRunId]);
    }
    const replaced = mod.replaceSubagentRunAfterSteerCore({
      previousRunId: params.previousRunId,
      nextRunId: params.nextRunId,
      fallback: params.fallback,
      transcriptTarget: params.transcriptTarget,
      task: params.task,
    });
    expect(replaced).toBe(true);

    const runs = listMainRuns();
    expect(runs).toHaveLength(1);
    expect(expectDefined(runs[0], "runs[0] test invariant").runId).toBe(params.nextRunId);
    return runs[0];
  };

  afterEach(async () => {
    vi.useRealTimers();
    mod.testing.setDepsForTest();
    announceSpy.mockReset();
    announceSpy.mockResolvedValue("delivered");
    runSubagentEndedHookMock.mockReset();
    runSubagentEndedHookMock.mockImplementation(async () => {});
    emitSessionLifecycleEventMock.mockReset();
    lifecycleHandler = undefined;
    removeInternalSessionEffectsSessionMock.mockClear();
    mod.resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("honors persisted steer suppression and only announces the replacement run", async () => {
    {
      registerRun({
        runId: "run-old",
        childSessionKey: "agent:main:subagent:steer",
        task: "initial task",
      });

      const previous = expectDefined(listMainRuns()[0], "registered run");
      expect(previous.runId).toBe("run-old");
      previous.suppressAnnounceReason = "steer-restart";

      emitLifecycleEnd("run-old");

      await flushAnnounce();
      expect(announceSpy).not.toHaveBeenCalled();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      expect(emitSessionLifecycleEventMock).not.toHaveBeenCalled();

      replaceRunAfterSteer({
        previousRunId: "run-old",
        nextRunId: "run-new",
        fallback: previous,
      });

      emitLifecycleEnd("run-new");

      await waitForRegistrySideEffect(() => {
        expect(announceSpy).toHaveBeenCalledTimes(1);
      });
      await waitForRegistrySideEffect(() => {
        const matchingCalls = runSubagentEndedHookMock.mock.calls.filter((call) => {
          const ctx = call[1] as { runId?: string } | undefined;
          return ctx?.runId === "run-new";
        });
        expect(matchingCalls).toHaveLength(1);
      });
      const hookCall = requireSubagentEndedHookCall("run-new");
      expect(hookCall.event.runId).toBe("run-new");
      expect(hookCall.ctx.runId).toBe("run-new");

      const announce = requireFirstAnnounceCall();
      expect(announce.childRunId).toBe("run-new");
    }
  });

  it("removes orphaned private transcript when steer replaces an internally resumed run", async () => {
    {
      registerRun({
        runId: "run-old",
        childSessionKey: "agent:main:subagent:steer",
        task: "initial task",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-old");
      if (!previous) {
        throw new Error("expected registered subagent run");
      }
      previous.execution = {
        status: "interrupted",
        startedAt: previous.execution.startedAt,
        transcriptTarget: {
          agentId: "main",
          sessionId: "internal-run-old",
          sessionKey: "agent:main:internal-session-effects:run-old",
          storePath: "/tmp/test-store",
        },
      };

      replaceRunAfterSteer({
        previousRunId: "run-old",
        nextRunId: "run-new",
        fallback: previous,
      });

      expect(removeInternalSessionEffectsSessionMock).toHaveBeenCalledWith(
        previous.execution.transcriptTarget,
      );
    }
  });

  it("defers subagent_ended hook for completion-mode runs until announce delivery resolves", async () => {
    {
      const resolveAnnounce = createDeferredAnnounceResolver();
      registerCompletionModeRun(
        "run-completion-delayed",
        "agent:main:subagent:completion-delayed",
        "completion-mode task",
      );

      emitLifecycleEnd("run-completion-delayed");

      await waitForRegistrySideEffect(() => {
        expect(announceSpy).toHaveBeenCalledTimes(1);
      });
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

      resolveAnnounce("delivered");
      await waitForRegistrySideEffect(() => {
        expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
      });
      const hookCall = requireSubagentEndedHookCall("run-completion-delayed");
      expect(hookCall.event.targetSessionKey).toBe("agent:main:subagent:completion-delayed");
      expect(hookCall.event.reason).toBe("subagent-complete");
      expect(hookCall.event.sendFarewell).toBe(true);
      expect(hookCall.ctx.runId).toBe("run-completion-delayed");
      expect(hookCall.ctx.requesterSessionKey).toBe(MAIN_REQUESTER_SESSION_KEY);
    }
  });

  it("does not emit subagent_ended on completion for persistent session-mode runs", async () => {
    {
      const resolveAnnounce = createDeferredAnnounceResolver();
      registerCompletionModeRun(
        "run-persistent-session",
        "agent:main:subagent:persistent-session",
        "persistent session task",
        { spawnMode: "session" },
      );

      emitLifecycleEnd("run-persistent-session");

      await flushAnnounce();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

      resolveAnnounce("delivered");
      await flushAnnounce();

      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      const run = listMainRuns()[0];
      expect(run?.runId).toBe("run-persistent-session");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
      expect(run?.endedHookEmittedAt).toBeUndefined();
    }
  });

  it("clears announce retry state when replacing after steer restart", () => {
    {
      registerRun({
        runId: "run-retry-reset-old",
        childSessionKey: "agent:main:subagent:retry-reset",
        task: "retry reset",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-retry-reset-old");
      if (previous) {
        previous.delivery = { status: "pending", attemptCount: 2, lastAttemptAt: Date.now() };
      }

      const run = expectDefined(
        replaceRunAfterSteer({
          previousRunId: "run-retry-reset-old",
          nextRunId: "run-retry-reset-new",
          fallback: previous,
        }),
        'replaceRunAfterSteer({ previousRunId: "run-retry-reset-old", nextRunI... test invariant',
      );
      expect(run.delivery?.attemptCount).toBeUndefined();
      expect(run.delivery?.lastAttemptAt).toBeUndefined();
    }
  });

  it("clears terminal lifecycle state when replacing after steer restart", async () => {
    {
      registerRun({
        runId: "run-terminal-state-old",
        childSessionKey: "agent:main:subagent:terminal-state",
        task: "terminal state",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-terminal-state-old");
      if (previous) {
        previous.endedHookEmittedAt = Date.now();
        previous.endedReason = "subagent-complete";
        previous.execution = {
          ...previous.execution,
          status: "terminal",
          endedAt: Date.now(),
          outcome: { status: "ok" },
        };
      }

      const run = expectDefined(
        replaceRunAfterSteer({
          previousRunId: "run-terminal-state-old",
          nextRunId: "run-terminal-state-new",
          fallback: previous,
        }),
        'replaceRunAfterSteer({ previousRunId: "run-terminal-state-old", nextR... test invariant',
      );
      expect(run.endedHookEmittedAt).toBeUndefined();
      expect(run.endedReason).toBeUndefined();

      emitLifecycleEnd("run-terminal-state-new");

      await waitForRegistrySideEffect(() => {
        const hookCall = requireSubagentEndedHookCall("run-terminal-state-new");
        expect(hookCall.event.runId).toBe("run-terminal-state-new");
        expect(hookCall.ctx.runId).toBe("run-terminal-state-new");
      });
      const lifecycleEvent = requireSessionLifecycleEventCall("terminal-state lifecycle event");
      expect(lifecycleEvent.sessionKey).toBe("agent:main:subagent:terminal-state");
      expect(lifecycleEvent.reason).toBe("subagent-status");
    }
  });

  it("clears frozen completion fields when replacing after steer restart", () => {
    registerRun({
      runId: "run-frozen-old",
      childSessionKey: "agent:main:subagent:frozen",
      task: "frozen result reset",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-frozen-old");
    if (previous) {
      previous.completion = {
        required: true,
        resultText: "stale frozen completion",
        capturedAt: Date.now(),
      };
      previous.cleanupCompletedAt = Date.now();
      previous.cleanupHandled = true;
    }

    const run = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-frozen-old",
        nextRunId: "run-frozen-new",
        fallback: previous,
      }),
      'replaceRunAfterSteer({ previousRunId: "run-frozen-old", nextRunId: "r... test invariant',
    );

    expect(run.completion?.resultText).toBeUndefined();
    expect(run.completion?.capturedAt).toBeUndefined();
    expect(run.cleanupCompletedAt).toBeUndefined();
    expect(run.cleanupHandled).toBe(false);
  });

  it("updates task to the dispatched steer message when provided", () => {
    // Regression test: orphan-session recovery
    // Registry restart recovery rewraps
    // `entry.task` into the [Subagent Task] block. If steer replacement did
    // not update `task` to the new message, a gateway restart classified as
    // resumable-fresh would re-run the stale pre-steer instruction and lose
    // the user's steer update.
    registerRun({
      runId: "run-steer-task-old",
      childSessionKey: "agent:main:subagent:steer-task",
      task: "original pre-steer task",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-steer-task-old");
    expect(previous?.taskRunId).toBe("run-steer-task-old");
    expect(previous?.generation).toBe(1);

    const run = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-steer-task-old",
        nextRunId: "run-steer-task-new",
        fallback: previous,
        task: "new steer instruction from user",
      }),
      'replaceRunAfterSteer({ previousRunId: "run-steer-task-old", nextRunId... test invariant',
    );

    expect(run.task).toBe("new steer instruction from user");
    expect(run.taskRunId).toBe("run-steer-task-old");
    expect(run.generation).toBe(2);
  });

  it("advances the generation from a fallback outside the live registry", () => {
    registerRun({
      runId: "run-fallback-generation-old",
      childSessionKey: "agent:main:subagent:fallback-generation",
      task: "restored replacement source",
    });
    const fallback = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-fallback-generation-old",
        nextRunId: "run-fallback-generation-restored",
      }),
      "restored fallback run",
    );
    subagentRuns.delete(fallback.runId);

    const run = expectDefined(
      replaceRunAfterSteer({
        previousRunId: fallback.runId,
        nextRunId: "run-fallback-generation-new",
        fallback,
      }),
      'replaceRunAfterSteer({ previousRunId: fallback.runId, nextRunId: "run... test invariant',
    );

    expect(run.generation).toBe(3);
  });

  it("preserves the previous task when no replacement is provided", () => {
    // Backwards-compatibility guard: callers that do not pass a new task
    // (legacy or test fixtures) should still inherit the prior task so that
    // orphan-session recovery remains deterministic.
    registerRun({
      runId: "run-task-preserve-old",
      childSessionKey: "agent:main:subagent:task-preserve",
      task: "preserve me verbatim",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-task-preserve-old");

    const run = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-task-preserve-old",
        nextRunId: "run-task-preserve-new",
        fallback: previous,
      }),
      'replaceRunAfterSteer({ previousRunId: "run-task-preserve-old", nextRu... test invariant',
    );

    expect(run.task).toBe("preserve me verbatim");
  });

  it("retains a legacy task owner fallback across another restart", () => {
    registerRun({
      runId: "run-legacy-owner-original",
      childSessionKey: "agent:main:subagent:legacy-owner",
      task: "legacy owner task",
    });
    const first = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-legacy-owner-original",
        nextRunId: "run-legacy-owner-restored",
      }),
      'replaceRunAfterSteer({ previousRunId: "run-legacy-owner-original", ne... test invariant',
    );
    // Pre-change persisted replacement rows did not record taskRunId.
    first.taskRunId = undefined;
    first.sessionStartedAt = first.createdAt - 1;

    const second = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-legacy-owner-restored",
        nextRunId: "run-legacy-owner-next",
        fallback: first,
      }),
      'replaceRunAfterSteer({ previousRunId: "run-legacy-owner-restored", ne... test invariant',
    );
    expect(second.taskRunId).toBe("run-legacy-owner-restored");
    expect(second.generation).toBe(3);
  });

  it("preserves cumulative session timing across steer replacement runs", () => {
    registerRun({
      runId: "run-runtime-old",
      childSessionKey: "agent:main:subagent:runtime",
      task: "keep timing stable",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-runtime-old");
    if (!previous) {
      throw new Error("missing previous run");
    }

    previous.execution.startedAt = 1_000;
    previous.sessionStartedAt = 1_000;
    previous.execution.endedAt = 121_000;
    previous.accumulatedRuntimeMs = 0;
    previous.execution.outcome = { status: "ok" };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);

    const replaced = mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-runtime-old",
      nextRunId: "run-runtime-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const next = listMainRuns().find((entry) => entry.runId === "run-runtime-new");
    if (next === undefined) {
      throw new Error("expected restarted run");
    }
    expect(mod.getSubagentSessionStartedAt(next)).toBe(1_000);
    expect(next.accumulatedRuntimeMs).toBe(120_000);

    if (!next.execution.startedAt) {
      throw new Error("missing next startedAt");
    }
    next.execution.endedAt = next.execution.startedAt + 30_000;
    expect(mod.getSubagentSessionRuntimeMs(next, next.execution.endedAt)).toBe(150_000);
  });

  it("rejects a replacement owned by a retired Gateway lifecycle", () => {
    registerRun({
      runId: "run-retired-generation-old",
      childSessionKey: "agent:main:subagent:retired-generation",
      task: "keep the current owner",
    });

    expect(
      mod.replaceSubagentRunAfterSteerCore({
        previousRunId: "run-retired-generation-old",
        nextRunId: "run-retired-generation-new",
        lifecycleGeneration: "retired-generation",
      }),
    ).toBe(false);
    expect(listMainRuns()).toEqual([
      expect.objectContaining({ runId: "run-retired-generation-old" }),
    ]);
  });

  it("stamps the captured Gateway lifecycle on a replacement run", () => {
    registerRun({
      runId: "run-current-generation-old",
      childSessionKey: "agent:main:subagent:current-generation",
      task: "continue under the dispatch owner",
    });

    expect(
      mod.replaceSubagentRunAfterSteerCore({
        previousRunId: "run-current-generation-old",
        nextRunId: "run-current-generation-new",
        lifecycleGeneration: "test-generation",
      }),
    ).toBe(true);
    expect(listMainRuns()).toEqual([
      expect.objectContaining({
        runId: "run-current-generation-new",
        execution: expect.objectContaining({ lifecycleGeneration: "test-generation" }),
      }),
    ]);
  });

  it("rolls back a generation-owned replacement when persistence fails", () => {
    registerRun({
      runId: "run-generation-persist-old",
      childSessionKey: "agent:main:subagent:generation-persist",
      task: "preserve the source owner",
    });
    const database = openOpenClawStateDatabase().db;
    database.exec(`CREATE TEMP TRIGGER reject_generation_replacement
      BEFORE INSERT ON subagent_runs
      WHEN NEW.run_id = 'run-generation-persist-new'
      BEGIN SELECT RAISE(ABORT, 'replacement unavailable'); END`);
    try {
      expect(
        mod.replaceSubagentRunAfterSteerCore({
          previousRunId: "run-generation-persist-old",
          nextRunId: "run-generation-persist-new",
          lifecycleGeneration: "test-generation",
        }),
      ).toBe(false);
    } finally {
      database.exec("DROP TRIGGER reject_generation_replacement");
    }
    expect(listMainRuns()).toEqual([
      expect.objectContaining({ runId: "run-generation-persist-old" }),
    ]);
  });

  it("clears completion delivery metadata when replacing for steer restart", () => {
    registerRun({
      runId: "run-delivery-old",
      childSessionKey: "agent:main:subagent:delivery-clear",
      task: "clear old delivery timestamps",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-delivery-old");
    if (!previous) {
      throw new Error("missing previous run");
    }
    previous.delivery = {
      status: "delivered",
      enqueuedAt: 1_000,
      deliveredAt: 2_000,
      announcedAt: 2_000,
      lastDropReason: "sink_unavailable",
    };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);

    const replaced = mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-delivery-old",
      nextRunId: "run-delivery-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const next = listMainRuns().find((entry) => entry.runId === "run-delivery-new");
    if (!next) {
      throw new Error("expected replacement run");
    }
    expect(next.delivery?.enqueuedAt).toBeUndefined();
    expect(next.delivery?.deliveredAt).toBeUndefined();
    expect(next.delivery?.announcedAt).toBeUndefined();
    expect(next.delivery?.lastDropReason).toBeUndefined();
  });

  it("preserves frozen completion as fallback when replacing for wake continuation", () => {
    registerRun({
      runId: "run-wake-old",
      childSessionKey: "agent:main:subagent:wake",
      task: "wake result fallback",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-wake-old");
    if (previous) {
      previous.completion = {
        required: true,
        resultText: "final summary before wake",
        capturedAt: 1234,
      };
      persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);
    }

    const replaced = mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-wake-old",
      nextRunId: "run-wake-new",
      fallback: previous,
      preserveFrozenResultFallback: true,
    });
    expect(replaced).toBe(true);

    const run = listMainRuns().find((entry) => entry.runId === "run-wake-new");
    if (!run) {
      throw new Error("expected wake replacement run");
    }
    expect(run.completion?.resultText).toBeUndefined();
    expect(run.completion?.fallbackResultText).toBe("final summary before wake");
    expect(run.completion?.fallbackCapturedAt).toBe(1234);
  });

  it("marks killed runs terminated and inactive while reconciliation is pending", async () => {
    const childSessionKey = "agent:main:subagent:killed";

    registerRun({
      runId: "run-killed",
      childSessionKey,
      task: "kill me",
    });
    const activeRun = listMainRuns()[0];
    if (!activeRun) {
      throw new Error("expected active run");
    }
    activeRun.execution = {
      ...activeRun.execution,
      status: activeRun.execution?.status ?? "running",
      transcriptTarget: {
        agentId: "main",
        sessionId: "recovered-subagent",
        sessionKey: "agent:main:internal-session-effects:recovered-subagent",
        storePath: "/tmp/test-store",
      },
    };

    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(true);
    const updated = mod.markSubagentRunTerminated({
      childSessionKey,
      reason: "manual kill",
    });
    expect(updated).toBe(1);
    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);

    const run = listMainRuns()[0];
    expect(run?.execution.outcome?.status).toBe("error");
    expect(run?.execution.outcome?.error).toBe("manual kill");
    expect(run?.execution.outcome?.startedAt).toBeTypeOf("number");
    expect(run?.execution.outcome?.endedAt).toBeTypeOf("number");
    expect(run?.execution.outcome?.elapsedMs).toBeTypeOf("number");
    expect(run?.execution.outcome?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(run?.execution.outcome?.endedAt).toBeGreaterThanOrEqual(
      run?.execution.outcome?.startedAt ?? 0,
    );
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    await flushAnnounce();
    expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
    expect(removeInternalSessionEffectsSessionMock).not.toHaveBeenCalled();
  });

  it("treats a child session as inactive when only a stale older row is still unended", () => {
    const childSessionKey = "agent:main:subagent:stale-active-older-row";

    mod.addSubagentRunForTests({
      runId: "run-stale-older",
      childSessionKey,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: MAIN_REQUESTER_DISPLAY_KEY,
      task: "older stale row",
      startedAt: 100,
      createdAt: 100,
      cleanup: "keep",
    });
    mod.addSubagentRunForTests({
      runId: "run-current-ended",
      childSessionKey,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: MAIN_REQUESTER_DISPLAY_KEY,
      task: "current ended row",
      startedAt: 200,
      createdAt: 200,
      endedAt: 250,
      outcome: { status: "ok" },
      cleanup: "keep",
    });

    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);
  });

  it("recovers announce cleanup when completion arrives after a kill marker", async () => {
    const childSessionKey = "agent:main:subagent:kill-race";
    registerRun({
      runId: "run-kill-race",
      childSessionKey,
      task: "race test",
    });

    expect(mod.markSubagentRunTerminated({ runId: "run-kill-race", reason: "manual kill" })).toBe(
      1,
    );
    expect(listMainRuns()[0]?.suppressAnnounceReason).toBe("killed");
    expect(listMainRuns()[0]?.cleanupHandled).toBe(true);
    expect(typeof listMainRuns()[0]?.cleanupCompletedAt).toBe("number");

    emitLifecycleEnd("run-kill-race");
    await flushAnnounce();
    await flushAnnounce();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = requireFirstAnnounceCall();
    expect(announce.childRunId).toBe("run-kill-race");

    const run = listMainRuns()[0];
    expect(run?.endedReason).toBe("subagent-complete");
    expect(run?.execution.outcome?.status).not.toBe("error");
    expect(run?.suppressAnnounceReason).toBeUndefined();
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    const hookCall = requireSubagentEndedHookCall("run-kill-race");
    expect(hookCall.event.reason).toBe("subagent-complete");
    expect(hookCall.event.outcome).toBe("ok");
    expect(hookCall.event.error).toBeUndefined();
  });

  it("retries deferred parent cleanup after a descendant announces", async () => {
    let parentAttempts = 0;
    announceSpy.mockImplementation(async (params: unknown) => {
      const typed = params as { childRunId?: string };
      if (typed.childRunId === "run-parent") {
        parentAttempts += 1;
        return parentAttempts >= 2 ? "delivered" : "retryable";
      }
      return "delivered";
    });

    registerRun({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      task: "parent task",
    });
    registerRun({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:parent:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "child task",
    });

    emitLifecycleEnd("run-parent");
    await waitForRegistrySideEffect(() => {
      const childRunIds = announceSpy.mock.calls.map(
        (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
      );
      expect(countMatching(childRunIds, (id) => id === "run-parent")).toBe(1);
    });

    emitLifecycleEnd("run-child");
    await waitForRegistrySideEffect(() => {
      const childRunIds = announceSpy.mock.calls.map(
        (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
      );
      expect(countMatching(childRunIds, (id) => id === "run-parent")).toBe(2);
      expect(countMatching(childRunIds, (id) => id === "run-child")).toBe(1);
    });

    const childRunIds = announceSpy.mock.calls.map(
      (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
    );
    expect(countMatching(childRunIds, (id) => id === "run-parent")).toBe(2);
    expect(countMatching(childRunIds, (id) => id === "run-child")).toBe(1);
  });

  it("retries completion delivery beyond three attempts and suspends at its deadline", async () => {
    {
      vi.useFakeTimers();
      try {
        announceSpy.mockResolvedValue("retryable");

        registerCompletionModeRun(
          "run-completion-retry",
          "agent:main:subagent:completion",
          "completion retry",
        );

        emitLifecycleEnd("run-completion-retry");

        await vi.advanceTimersByTimeAsync(0);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        expect(listMainRuns()[0]?.delivery?.attemptCount).toBe(1);

        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(announceSpy.mock.calls.length).toBeGreaterThan(3);
        expect(listMainRuns()[0]?.delivery?.status).not.toBe("suspended");

        const deadlineAt = listMainRuns()[0]?.delivery?.deadlineAt;
        expect(deadlineAt).toBeTypeOf("number");
        vi.setSystemTime((deadlineAt ?? Date.now()) + 1);
        mod.resumeSubagentRun("run-completion-retry");
        await vi.advanceTimersByTimeAsync(0);
        await waitForRegistrySideEffect(() => {
          const run = listMainRuns()[0];
          expect(run?.delivery?.status).toBe("suspended");
          expect(run?.delivery?.suspendedAt).toBeTypeOf("number");
          expect(run?.delivery?.suspendedReason).toBe("expiry");
          expect(run?.cleanupCompletedAt).toBeUndefined();
        });
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("keeps completion cleanup pending while descendants are still active", async () => {
    announceSpy.mockResolvedValue("retryable");

    registerCompletionModeRun(
      "run-parent-expiry",
      "agent:main:subagent:parent-expiry",
      "parent completion expiry",
    );
    registerRun({
      runId: "run-child-active",
      childSessionKey: "agent:main:subagent:parent-expiry:subagent:child-active",
      requesterSessionKey: "agent:main:subagent:parent-expiry",
      requesterDisplayKey: "parent-expiry",
      task: "child still running",
    });

    emitLifecycleEnd("run-parent-expiry", {
      startedAt: Date.now() - 7 * 60_000,
      endedAt: Date.now() - 6 * 60_000,
    });

    await flushAnnounce();

    const parentHookCall = runSubagentEndedHookMock.mock.calls.find((call) => {
      const event = call[0] as { runId?: string; reason?: string };
      return event.runId === "run-parent-expiry" && event.reason === "subagent-complete";
    });
    expect(parentHookCall).toBeUndefined();
    const parent = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((entry) => entry.runId === "run-parent-expiry");
    expect(parent?.cleanupCompletedAt).toBeUndefined();
    expect(parent?.cleanupHandled).toBe(false);
  });
});
