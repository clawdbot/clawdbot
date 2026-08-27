// Covers atomic refuse-only suspension preparation, renewal, and release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSession,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  markBackgrounded,
  markExited,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";

const SUSPEND_TTL_MS = 2 * 60_000;
const SUSPEND_RETRY_AFTER_MS = 20_000;

function inspectors(
  overrides: Partial<GatewayActiveWorkInspectors> = {},
): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

describe("gateway suspend coordinator", () => {
  it.each([false, true])(
    "lifecycle reset resumes a held scheduler before admission is cleared (drain: %s)",
    (drain) => {
      const resumeScheduling = vi.fn(() => {
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
      });
      expect(
        prepareGatewaySuspend({
          requestId: "request-lifecycle-reset",
          drain,
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors({ getQueueSize: () => Number(drain) }),
        }),
      ).toMatchObject({ status: drain ? "draining" : "ready" });

      markGatewayRestartDraining();
      expect(resumeScheduling).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      resetGatewaySuspendCoordinatorForLifecycleRestart();

      expect(resumeScheduling).toHaveBeenCalledOnce();
      resetGatewayWorkAdmission();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    },
  );

  it("test reset resumes a held scheduler before admission is cleared", () => {
    const resumeScheduling = vi.fn(() => {
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    });
    expect(
      prepareGatewaySuspend({
        requestId: "request-lifecycle-reset",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
      }),
    ).toMatchObject({ status: "ready" });

    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("reopens admission in the same turn when active work refuses preparation", () => {
    const events: string[] = [];
    const result = prepareGatewaySuspend({
      requestId: "request-busy",
      pauseScheduling: () => events.push("pause"),
      resumeScheduling: () => events.push("resume"),
      inspect: inspectors({
        getQueueSize: () => {
          events.push("inspect");
          return 1;
        },
      }),
    });

    expect(result.status).toBe("busy");
    expect(events).toEqual(["pause", "inspect", "resume"]);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("rejects terminating drain requests before acquiring admission or pausing scheduling", () => {
    const pauseScheduling = vi.fn();

    expect(() =>
      prepareGatewaySuspend({
        requestId: "request-invalid-terminating-drain",
        terminalPolicy: "terminate",
        drain: true,
        pauseScheduling,
        resumeScheduling: vi.fn(),
        inspect: inspectors(),
      }),
    ).toThrow("gateway suspension draining requires terminalPolicy preserve");

    expect(pauseScheduling).not.toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("holds a preserve-only drain until terminal persistence, delivery, and sessions settle", () => {
    let pendingReplies = 1;
    let terminalPersistence = 1;
    let terminalSessions = 1;
    const pauseScheduling = vi.fn();
    const resumeScheduling = vi.fn();
    const inspect = inspectors({
      getPendingReplies: () => pendingReplies,
      getTerminalPersistence: () => terminalPersistence,
      getTerminalSessions: () => terminalSessions,
    });

    expect(
      prepareGatewaySuspend({
        requestId: "request-preserve-drain",
        terminalPolicy: "preserve",
        drain: true,
        pauseScheduling,
        resumeScheduling,
        inspect,
        nowMs: () => 1_000,
        createSuspensionId: () => "suspension-preserve-drain",
      }),
    ).toEqual({
      status: "draining",
      suspensionId: "suspension-preserve-drain",
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
      activeCount: 3,
      blockers: [
        { kind: "reply", count: 1, message: "1 pending reply delivery operation(s)" },
        {
          kind: "terminal-persistence",
          count: 1,
          message: "1 pending terminal session write(s)",
        },
        { kind: "terminal-session", count: 1, message: "1 open terminal session(s)" },
      ],
    });
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

    terminalPersistence = 0;
    terminalSessions = 0;
    expect(getGatewaySuspendStatus("suspension-preserve-drain")).toEqual({
      status: "draining",
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
      activeCount: 1,
      blockers: [{ kind: "reply", count: 1, message: "1 pending reply delivery operation(s)" }],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("draining");

    pendingReplies = 0;
    expect(getGatewaySuspendStatus("suspension-preserve-drain")).toEqual({
      status: "ready",
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(resumeGatewaySuspend("suspension-preserve-drain")).toEqual({
      ok: true,
      status: "running",
      resumed: true,
    });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("renews the same draining owner and rejects conflicting request, policy, or drain modes", () => {
    let queued = 2;
    let nowMs = 1_000;
    const pauseScheduling = vi.fn();
    const resumeScheduling = vi.fn();
    const params = {
      requestId: "request-drain-renewal",
      terminalPolicy: "preserve" as const,
      drain: true,
      pauseScheduling,
      resumeScheduling,
      inspect: inspectors({ getQueueSize: () => queued }),
      nowMs: () => nowMs,
      createSuspensionId: () => "suspension-drain-renewal",
    };

    expect(prepareGatewaySuspend(params)).toMatchObject({
      status: "draining",
      suspensionId: "suspension-drain-renewal",
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
      activeCount: 2,
    });

    nowMs = 2_000;
    queued = 1;
    expect(prepareGatewaySuspend(params)).toMatchObject({
      status: "draining",
      suspensionId: "suspension-drain-renewal",
      expiresAtMs: 2_000 + SUSPEND_TTL_MS,
      activeCount: 1,
    });
    for (const conflict of [
      { requestId: "request-other" },
      { drain: false },
      { terminalPolicy: "terminate" as const, drain: false },
    ]) {
      expect(prepareGatewaySuspend({ ...params, ...conflict })).toEqual({
        status: "conflict",
        expiresAtMs: 2_000 + SUSPEND_TTL_MS,
      });
    }
    expect(pauseScheduling).toHaveBeenCalledOnce();

    nowMs = 3_000;
    queued = 0;
    expect(prepareGatewaySuspend(params)).toEqual({
      status: "ready",
      suspensionId: "suspension-drain-renewal",
      expiresAtMs: 3_000 + SUSPEND_TTL_MS,
      activeCount: 0,
      blockers: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expect(resumeScheduling).not.toHaveBeenCalled();
  });

  it("resumes a still-draining lease without dropping its admission fence first", () => {
    const resumeScheduling = vi.fn(() => {
      expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
    });
    expect(
      prepareGatewaySuspend({
        requestId: "request-draining-resume",
        drain: true,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getTerminalSessions: () => 1 }),
        createSuspensionId: () => "suspension-draining-resume",
      }),
    ).toMatchObject({ status: "draining" });

    expect(resumeGatewaySuspend("suspension-draining-resume")).toEqual({
      ok: true,
      status: "running",
      resumed: true,
    });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each([undefined, "preserve"] as const)(
    "keeps terminal sessions blocking with terminal policy %s",
    (terminalPolicy) => {
      expect(
        prepareGatewaySuspend({
          requestId: `request-terminal-${terminalPolicy ?? "default"}`,
          terminalPolicy,
          pauseScheduling: vi.fn(),
          resumeScheduling: vi.fn(),
          inspect: inspectors({ getTerminalSessions: () => 2 }),
        }),
      ).toEqual({
        status: "busy",
        reason: "active-work",
        retryAfterMs: SUSPEND_RETRY_AFTER_MS,
        activeCount: 2,
        blockers: [
          {
            kind: "terminal-session",
            count: 2,
            message: "2 open terminal session(s)",
          },
        ],
      });
    },
  );

  it("retains terminal diagnostics when terminal sessions are not blockers", () => {
    const preserving = createGatewayActiveWorkSnapshot(
      inspectors({ getTerminalSessions: () => 2 }),
    );
    const ignoring = createGatewayActiveWorkSnapshot(inspectors({ getTerminalSessions: () => 2 }), {
      ignoreTerminalSessions: true,
    });

    expect(preserving).toMatchObject({
      idle: false,
      counts: { terminalSessions: 2, totalActive: 2 },
      blockers: [expect.objectContaining({ kind: "terminal-session", count: 2 })],
    });
    expect(ignoring).toMatchObject({
      idle: true,
      counts: { terminalSessions: 2, totalActive: 0 },
      blockers: [],
    });
  });

  it("prepares with terminal sessions excluded when they will be terminated", () => {
    const params = {
      requestId: "request-terminal-terminate",
      terminalPolicy: "terminate" as const,
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors({ getTerminalSessions: () => 2 }),
    };
    const ready = prepareGatewaySuspend(params);
    expect(ready).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
    expect(prepareGatewaySuspend(params)).toMatchObject({
      status: "ready",
      activeCount: 0,
      blockers: [],
    });
    expect(prepareGatewaySuspend({ ...params, terminalPolicy: "preserve" })).toMatchObject({
      status: "conflict",
    });
  });

  it("keeps persistence and other active work blocking under terminal termination policy", () => {
    expect(
      prepareGatewaySuspend({
        requestId: "request-terminal-terminate-busy",
        terminalPolicy: "terminate",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors({
          getQueueSize: () => 1,
          getTerminalPersistence: () => 1,
          getTerminalSessions: () => 2,
        }),
      }),
    ).toEqual({
      status: "busy",
      reason: "active-work",
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
      activeCount: 2,
      blockers: [
        { kind: "queue", count: 1, message: "1 queued or active operation(s)" },
        {
          kind: "terminal-persistence",
          count: 1,
          message: "1 pending terminal session write(s)",
        },
      ],
    });
  });

  it("stays busy after a background session is hidden until its process exits", () => {
    const session = createProcessSessionFixture({
      id: "private-background-session",
      command: "private command",
    });
    addSession(session);
    markBackgrounded(session);
    deleteSession(session.id);

    const inspect = inspectors({
      getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
    });
    expect(
      prepareGatewaySuspend({
        requestId: "request-background-exec",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect,
      }),
    ).toEqual({
      status: "busy",
      reason: "active-work",
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
      activeCount: 1,
      blockers: [
        {
          kind: "background-exec",
          count: 1,
          message: "1 active background exec session(s)",
        },
      ],
    });

    markExited(session, 0, null, "completed");
    expect(
      prepareGatewaySuspend({
        requestId: "request-background-exec",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect,
      }),
    ).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
  });

  it("keeps admission closed until a failed busy rollback resumes scheduling", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      const first = prepareGatewaySuspend({
        requestId: "request-busy-resume-retry",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => 1 }),
      });

      expect(first).toEqual({
        status: "recovering",
        reason: "scheduler-resume-failed",
        retryAfterMs: 1_000,
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(getGatewaySuspendStatus("stale-id")).toEqual(first);
      expect(resumeGatewaySuspend("stale-id")).toEqual({
        ok: false,
        reason: "scheduler-resume-failed",
        retryAfterMs: 1_000,
      });
      expect(
        prepareGatewaySuspend({
          requestId: "request-before-scheduler-resume",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors(),
        }),
      ).toEqual(first);

      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(getGatewaySuspendStatus("stale-id")).toEqual({ status: "running" });

      expect(
        prepareGatewaySuspend({
          requestId: "request-after-scheduler-resume",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors(),
          createSuspensionId: () => "suspension-after-scheduler-resume",
        }),
      ).toMatchObject({
        status: "ready",
        suspensionId: "suspension-after-scheduler-resume",
      });
      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels scheduler recovery when restart supersedes suspension", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi.fn(() => {
        throw new Error("timer unavailable");
      });
      expect(
        prepareGatewaySuspend({
          requestId: "request-recovery-restart",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors({ getQueueSize: () => 1 }),
        }),
      ).toMatchObject({ status: "recovering" });

      markGatewayRestartDraining();
      vi.advanceTimersByTime(1_000);

      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(getGatewaySuspendStatus("stale-id")).toEqual({ status: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns recovery when inspection fails before admission commits", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      const result = prepareGatewaySuspend({
        requestId: "request-inspection-failure",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({
          getQueueSize: () => {
            throw new Error("inspection failed");
          },
        }),
      });

      expect(result).toMatchObject({ status: "recovering" });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews one ready lease and resumes only with the matching id", () => {
    const resumeScheduling = vi.fn();
    expect(
      prepareGatewaySuspend({
        requestId: "request-ready",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
        nowMs: () => 1_000,
        createSuspensionId: () => "suspension-1",
      }),
    ).toMatchObject({
      status: "ready",
      suspensionId: "suspension-1",
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
    });
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    expect(
      prepareGatewaySuspend({
        requestId: "request-ready",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => 99 }),
        nowMs: () => 2_000,
      }),
    ).toMatchObject({
      status: "ready",
      suspensionId: "suspension-1",
      expiresAtMs: 2_000 + SUSPEND_TTL_MS,
    });
    expect(
      prepareGatewaySuspend({
        requestId: "request-other",
        pauseScheduling: vi.fn(),
        resumeScheduling,
      }).status,
    ).toBe("conflict");

    expect(resumeGatewaySuspend("wrong-id")).toEqual({
      ok: false,
      reason: "suspension-mismatch",
    });
    expect(resumeGatewaySuspend("suspension-1")).toEqual({
      ok: true,
      status: "running",
      resumed: true,
    });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each([false, true])(
    "lets restart supersede a suspension without reopening its scheduler (drain: %s)",
    (drain) => {
      const resumeScheduling = vi.fn();
      const result = prepareGatewaySuspend({
        requestId: "request-restart",
        drain,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => Number(drain) }),
        createSuspensionId: () => "suspension-restart",
      });
      expect(result.status).toBe(drain ? "draining" : "ready");

      markGatewayRestartDraining();

      expect(getGatewaySuspendStatus("suspension-restart")).toEqual({ status: "running" });
      expect(resumeScheduling).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    },
  );

  it.each([false, true])(
    "exposes scheduler recovery after a held lease cannot resume (drain: %s)",
    (drain) => {
      vi.useFakeTimers();
      try {
        const resumeScheduling = vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("timer unavailable");
          })
          .mockImplementationOnce(() => {});
        prepareGatewaySuspend({
          requestId: "request-resume-retry",
          drain,
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors({ getQueueSize: () => Number(drain) }),
          createSuspensionId: () => "suspension-resume-retry",
        });

        expect(resumeGatewaySuspend("suspension-resume-retry")).toMatchObject({
          ok: false,
          reason: "scheduler-resume-failed",
        });
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(getGatewaySuspendStatus("suspension-resume-retry")).toMatchObject({
          status: "recovering",
        });
        expect(
          prepareGatewaySuspend({
            requestId: "request-resume-retry",
            pauseScheduling: vi.fn(),
            resumeScheduling,
            inspect: inspectors(),
          }),
        ).toMatchObject({ status: "recovering" });
        expect(resumeGatewaySuspend("suspension-resume-retry")).toMatchObject({
          ok: false,
          reason: "scheduler-resume-failed",
        });

        vi.advanceTimersByTime(1_000);
        expect(resumeScheduling).toHaveBeenCalledTimes(2);
        expect(getGatewaySuspendStatus("suspension-resume-retry")).toEqual({ status: "running" });
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])("auto-resumes an abandoned lease at expiry (drain: %s)", (drain) => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi.fn();
      prepareGatewaySuspend({
        requestId: "request-expiry",
        drain,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => Number(drain) }),
        createSuspensionId: () => "suspension-expiry",
      });

      vi.advanceTimersByTime(SUSPEND_TTL_MS);

      expect(getGatewaySuspendStatus("suspension-expiry")).toEqual({ status: "running" });
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an already-queued expiry callback after the same drain lease is renewed", () => {
    vi.useFakeTimers();
    try {
      let nowMs = 1_000;
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const resumeScheduling = vi.fn();
      const params = {
        requestId: "request-stale-drain-expiry",
        drain: true,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getTerminalSessions: () => 1 }),
        nowMs: () => nowMs,
        createSuspensionId: () => "suspension-stale-drain-expiry",
      };

      expect(prepareGatewaySuspend(params)).toMatchObject({ status: "draining" });
      const staleExpiry = timeoutSpy.mock.calls[0]?.[0];
      expect(typeof staleExpiry).toBe("function");

      nowMs = 2_000;
      expect(prepareGatewaySuspend(params)).toMatchObject({
        status: "draining",
        expiresAtMs: 2_000 + SUSPEND_TTL_MS,
      });
      if (typeof staleExpiry !== "function") {
        throw new Error("missing initial suspension expiry callback");
      }
      staleExpiry();

      expect(resumeScheduling).not.toHaveBeenCalled();
      expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
      expect(getGatewaySuspendStatus("suspension-stale-drain-expiry")).toMatchObject({
        status: "draining",
        expiresAtMs: 2_000 + SUSPEND_TTL_MS,
      });

      vi.advanceTimersByTime(SUSPEND_TTL_MS);
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("enters recovery when lease expiry cannot resume the scheduler", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      prepareGatewaySuspend({
        requestId: "request-expiry-recovery",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
        createSuspensionId: () => "suspension-expiry-recovery",
      });

      vi.advanceTimersByTime(SUSPEND_TTL_MS);
      expect(getGatewaySuspendStatus("suspension-expiry-recovery")).toMatchObject({
        status: "recovering",
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(getGatewaySuspendStatus("suspension-expiry-recovery")).toEqual({
        status: "running",
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "expires synchronously when timer delivery is delayed (drain: %s)",
    (drain) => {
      let nowMs = 10_000;
      const resumeScheduling = vi.fn();
      prepareGatewaySuspend({
        requestId: "request-delayed-expiry",
        drain,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => Number(drain) }),
        nowMs: () => nowMs,
        createSuspensionId: () => "suspension-delayed-expiry",
      });

      nowMs += SUSPEND_TTL_MS;

      expect(getGatewaySuspendStatus("suspension-delayed-expiry")).toEqual({ status: "running" });
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    },
  );
});
