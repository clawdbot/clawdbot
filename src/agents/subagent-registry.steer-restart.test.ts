import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
      };
    }) => void)
  | undefined;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent.wait") {
      return { status: "pending" };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("../config/sessions.js", () => {
  const sessionStore = new Proxy<Record<string, { sessionId: string; updatedAt: number }>>(
    {},
    {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return { sessionId: `sess-${prop}`, updatedAt: 1 };
      },
    },
  );

  return {
    loadSessionStore: vi.fn(() => sessionStore),
    resolveAgentIdFromSessionKey: (key: string) => {
      const match = key.match(/^agent:([^:]+)/);
      return match?.[1] ?? "main";
    },
    resolveMainSessionKey: () => "agent:main:main",
    resolveStorePath: () => "/tmp/test-store",
    updateSessionStore: vi.fn(),
  };
});

const announceSpy = vi.fn(async (_params: unknown) => true);
const runSubagentEndedHookMock = vi.fn(async (_event?: unknown, _ctx?: unknown) => {});
const emitSessionLifecycleEventMock = vi.fn();
vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_ended",
    runSubagentEnded: runSubagentEndedHookMock,
  })),
  getGlobalPluginRegistry: vi.fn(() => null),
  hasGlobalHooks: vi.fn((hookName: string) => hookName === "subagent_ended"),
  initializeGlobalHookRunner: vi.fn(),
  resetGlobalHookRunner: vi.fn(),
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: emitSessionLifecycleEventMock,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry steer restarts", () => {
  let mod: typeof import("./subagent-registry.js");
  type RegisterSubagentRunInput = Parameters<typeof mod.registerSubagentRun>[0];
  const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";
  const MAIN_REQUESTER_DISPLAY_KEY = "main";

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    lifecycleHandler = undefined;
    announceSpy.mockReset();
    announceSpy.mockResolvedValue(true);
    runSubagentEndedHookMock.mockReset();
    runSubagentEndedHookMock.mockImplementation(async () => {});
    emitSessionLifecycleEventMock.mockReset();
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  const flushAnnounce = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const withPendingAgentWait = async <T>(run: () => Promise<T>): Promise<T> => {
    const callGateway = vi.mocked((await import("../gateway/call.js")).callGateway);
    const originalCallGateway = callGateway.getMockImplementation();
    callGateway.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string };
      if (typed.method === "agent.wait") {
        return new Promise<unknown>(() => undefined);
      }
      if (originalCallGateway) {
        return originalCallGateway(request as Parameters<typeof callGateway>[0]);
      }
      return {};
    });

    try {
      return await run();
    } finally {
      if (originalCallGateway) {
        callGateway.mockImplementation(originalCallGateway);
      }
    }
  };

  const createDeferredAnnounceResolver = (): ((value: boolean) => void) => {
    let resolveAnnounce!: (value: boolean) => void;
    announceSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAnnounce = resolve;
        }),
    );
    return (value: boolean) => {
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
    } = {},
  ) => {
    lifecycleHandler?.({
      stream: "lifecycle",
      runId,
      data: {
        phase: "end",
        ...data,
      },
    });
  };

  const replaceRunAfterSteer = (params: {
    previousRunId: string;
    nextRunId: string;
    fallback?: ReturnType<typeof listMainRuns>[number];
  }) => {
    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: params.previousRunId,
      nextRunId: params.nextRunId,
      fallback: params.fallback,
    });
    expect(replaced).toBe(true);

    const runs = listMainRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe(params.nextRunId);
    return runs[0];
  };

  afterEach(async () => {
    announceSpy.mockReset();
    announceSpy.mockResolvedValue(true);
    runSubagentEndedHookMock.mockReset();
    runSubagentEndedHookMock.mockImplementation(async () => {});
    emitSessionLifecycleEventMock.mockReset();
    lifecycleHandler = undefined;
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("suppresses announce for interrupted runs and only announces the replacement run", async () => {
    await withPendingAgentWait(async () => {
      registerRun({
        runId: "run-old",
        childSessionKey: "agent:main:subagent:steer",
        task: "initial task",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-old");

      const marked = mod.markSubagentRunForSteerRestart("run-old");
      expect(marked).toBe(true);

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

      await vi.waitFor(() => {
        expect(announceSpy).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        const matchingCalls = runSubagentEndedHookMock.mock.calls.filter((call) => {
          const ctx = call[1] as { runId?: string } | undefined;
          return ctx?.runId === "run-new";
        });
        expect(matchingCalls).toHaveLength(1);
      });
      expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-new",
        }),
        expect.objectContaining({
          runId: "run-new",
        }),
      );

      const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
      expect(announce.childRunId).toBe("run-new");
    });
  });

  it("defers subagent_ended hook for completion-mode runs until announce delivery resolves", async () => {
    await withPendingAgentWait(async () => {
      const resolveAnnounce = createDeferredAnnounceResolver();
      registerCompletionModeRun(
        "run-completion-delayed",
        "agent:main:subagent:completion-delayed",
        "completion-mode task",
      );

      emitLifecycleEnd("run-completion-delayed");

      await vi.waitFor(() => {
        expect(announceSpy).toHaveBeenCalledTimes(1);
      });
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

      resolveAnnounce(true);
      await vi.waitFor(() => {
        expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
      });
      expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSessionKey: "agent:main:subagent:completion-delayed",
          reason: "subagent-complete",
          sendFarewell: true,
        }),
        expect.objectContaining({
          runId: "run-completion-delayed",
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        }),
      );
    });
  });

  it("does not emit subagent_ended on completion for persistent session-mode runs", async () => {
    await withPendingAgentWait(async () => {
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

      resolveAnnounce(true);
      await flushAnnounce();

      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      const run = listMainRuns()[0];
      expect(run?.runId).toBe("run-persistent-session");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
      expect(run?.endedHookEmittedAt).toBeUndefined();
    });
  });

  it("clears announce retry state when replacing after steer restart", async () => {
    await withPendingAgentWait(async () => {
      registerRun({
        runId: "run-retry-reset-old",
        childSessionKey: "agent:main:subagent:retry-reset",
        task: "retry reset",
      });

      const previous = listMainRuns()[0];
      expect(previous?.runId).toBe("run-retry-reset-old");
      if (previous) {
        previous.announceRetryCount = 2;
        previous.lastAnnounceRetryAt = Date.now();
      }

      const run = replaceRunAfterSteer({
        previousRunId: "run-retry-reset-old",
        nextRunId: "run-retry-reset-new",
        fallback: previous,
      });
      expect(run.announceRetryCount).toBeUndefined();
      expect(run.lastAnnounceRetryAt).toBeUndefined();
    });
  });

  it("clears terminal lifecycle state when replacing after steer restart", async () => {
    await withPendingAgentWait(async () => {
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
        previous.endedAt = Date.now();
        previous.outcome = { status: "ok" };
      }

      const run = replaceRunAfterSteer({
        previousRunId: "run-terminal-state-old",
        nextRunId: "run-terminal-state-new",
        fallback: previous,
      });
      expect(run.endedHookEmittedAt).toBeUndefined();
      expect(run.endedReason).toBeUndefined();

      emitLifecycleEnd("run-terminal-state-new");

      await vi.waitFor(() => {
        expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: "run-terminal-state-new",
          }),
          expect.objectContaining({
            runId: "run-terminal-state-new",
          }),
        );
      });
      expect(emitSessionLifecycleEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:subagent:terminal-state",
          reason: "subagent-status",
        }),
      );
    });
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
      previous.frozenResultText = "stale frozen completion";
      previous.frozenResultCapturedAt = Date.now();
      previous.cleanupCompletedAt = Date.now();
      previous.cleanupHandled = true;
    }

    const run = replaceRunAfterSteer({
      previousRunId: "run-frozen-old",
      nextRunId: "run-frozen-new",
      fallback: previous,
    });

    expect(run.frozenResultText).toBeUndefined();
    expect(run.frozenResultCapturedAt).toBeUndefined();
    expect(run.cleanupCompletedAt).toBeUndefined();
    expect(run.cleanupHandled).toBe(false);
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

    previous.startedAt = 1_000;
    previous.sessionStartedAt = 1_000;
    previous.endedAt = 121_000;
    previous.accumulatedRuntimeMs = 0;
    previous.outcome = { status: "ok" };

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-runtime-old",
      nextRunId: "run-runtime-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const next = listMainRuns().find((entry) => entry.runId === "run-runtime-new");
    expect(next).toBeDefined();
    expect(mod.getSubagentSessionStartedAt(next)).toBe(1_000);
    expect(next?.accumulatedRuntimeMs).toBe(120_000);

    if (!next?.startedAt) {
      throw new Error("missing next startedAt");
    }
    next.endedAt = next.startedAt + 30_000;
    expect(mod.getSubagentSessionRuntimeMs(next, next.endedAt)).toBe(150_000);
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
      previous.frozenResultText = "final summary before wake";
      previous.frozenResultCapturedAt = 1234;
    }

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-wake-old",
      nextRunId: "run-wake-new",
      fallback: previous,
      preserveFrozenResultFallback: true,
    });
    expect(replaced).toBe(true);

    const run = listMainRuns().find((entry) => entry.runId === "run-wake-new");
    expect(run).toMatchObject({
      frozenResultText: undefined,
      fallbackFrozenResultText: "final summary before wake",
      fallbackFrozenResultCapturedAt: 1234,
    });
  });

  it("restores announce for a finished run when steer replacement dispatch fails", async () => {
    registerRun({
      runId: "run-failed-restart",
      childSessionKey: "agent:main:subagent:failed-restart",
      task: "initial task",
    });

    expect(mod.markSubagentRunForSteerRestart("run-failed-restart")).toBe(true);

    emitLifecycleEnd("run-failed-restart");

    await flushAnnounce();
    expect(announceSpy).not.toHaveBeenCalled();

    expect(mod.clearSubagentRunSteerRestart("run-failed-restart")).toBe(true);
    await flushAnnounce();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
    expect(announce.childRunId).toBe("run-failed-restart");
  });

  it("marks killed runs terminated and inactive", async () => {
    const childSessionKey = "agent:main:subagent:killed";

    registerRun({
      runId: "run-killed",
      childSessionKey,
      task: "kill me",
    });

    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(true);
    const updated = mod.markSubagentRunTerminated({
      childSessionKey,
      reason: "manual kill",
    });
    expect(updated).toBe(1);
    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);

    const run = listMainRuns()[0];
    expect(run?.outcome).toEqual({ status: "error", error: "manual kill" });
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    await vi.waitFor(() => {
      expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
        {
          targetSessionKey: childSessionKey,
          targetKind: "subagent",
          reason: "subagent-killed",
          sendFarewell: true,
          accountId: undefined,
          runId: "run-killed",
          endedAt: expect.any(Number),
          outcome: "killed",
          error: "manual kill",
        },
        {
          runId: "run-killed",
          childSessionKey,
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        },
      );
    });
  });

  it("treats a child session as inactive when only a stale older row is still unended", async () => {
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
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
    expect(announce.childRunId).toBe("run-kill-race");

    const run = listMainRuns()[0];
    expect(run?.endedReason).toBe("subagent-complete");
    expect(run?.outcome?.status).not.toBe("error");
    expect(run?.suppressAnnounceReason).toBeUndefined();
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
  });

  it("retries deferred parent cleanup after a descendant announces", async () => {
    let parentAttempts = 0;
    announceSpy.mockImplementation(async (params: unknown) => {
      const typed = params as { childRunId?: string };
      if (typed.childRunId === "run-parent") {
        parentAttempts += 1;
        return parentAttempts >= 2;
      }
      return true;
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
    await vi.waitFor(() => {
      const childRunIds = announceSpy.mock.calls.map(
        (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
      );
      expect(childRunIds.filter((id) => id === "run-parent")).toHaveLength(1);
    });

    emitLifecycleEnd("run-child");
    await vi.waitFor(() => {
      const childRunIds = announceSpy.mock.calls.map(
        (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
      );
      expect(childRunIds.filter((id) => id === "run-parent")).toHaveLength(2);
      expect(childRunIds.filter((id) => id === "run-child")).toHaveLength(1);
    });

    const childRunIds = announceSpy.mock.calls.map(
      (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
    );
    expect(childRunIds.filter((id) => id === "run-parent")).toHaveLength(2);
    expect(childRunIds.filter((id) => id === "run-child")).toHaveLength(1);
  });

  it("retries completion-mode announce delivery with backoff and then gives up after retry limit", async () => {
    await withPendingAgentWait(async () => {
      vi.useFakeTimers();
      try {
        announceSpy.mockResolvedValue(false);

        registerCompletionModeRun(
          "run-completion-retry",
          "agent:main:subagent:completion",
          "completion retry",
        );

        emitLifecycleEnd("run-completion-retry");

        await vi.advanceTimersByTimeAsync(0);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        expect(listMainRuns()[0]?.announceRetryCount).toBe(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(announceSpy).toHaveBeenCalledTimes(2);
        expect(listMainRuns()[0]?.announceRetryCount).toBe(2);

        await vi.advanceTimersByTimeAsync(1_999);
        expect(announceSpy).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(announceSpy).toHaveBeenCalledTimes(3);
        expect(listMainRuns()[0]?.announceRetryCount).toBe(3);

        await vi.advanceTimersByTimeAsync(4_001);
        expect(announceSpy).toHaveBeenCalledTimes(3);
        expect(listMainRuns()[0]?.cleanupCompletedAt).toBeTypeOf("number");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps completion cleanup pending while descendants are still active", async () => {
    announceSpy.mockResolvedValue(false);

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
