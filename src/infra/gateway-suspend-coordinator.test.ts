// Covers atomic refuse-only suspension preparation, renewal, and release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSession,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import {
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
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
  it("lifecycle reset resumes a held scheduler before admission is cleared", () => {
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

    markGatewayRestartDraining();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    resetGatewaySuspendCoordinatorForLifecycleRestart();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    resetGatewayWorkAdmission();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

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

  it("lets restart supersede a suspension without reopening its scheduler", () => {
    const resumeScheduling = vi.fn();
    const result = prepareGatewaySuspend({
      requestId: "request-restart",
      pauseScheduling: vi.fn(),
      resumeScheduling,
      inspect: inspectors(),
      createSuspensionId: () => "suspension-restart",
    });
    expect(result.status).toBe("ready");

    markGatewayRestartDraining();

    expect(getGatewaySuspendStatus("suspension-restart")).toEqual({ status: "running" });
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
  });

  it("exposes scheduler recovery after a ready lease cannot resume", () => {
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
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
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
  });

  it("auto-resumes an abandoned ready lease at expiry", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi.fn();
      prepareGatewaySuspend({
        requestId: "request-expiry",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
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

  it("expires synchronously when timer delivery is delayed", () => {
    let nowMs = 10_000;
    const resumeScheduling = vi.fn();
    prepareGatewaySuspend({
      requestId: "request-delayed-expiry",
      pauseScheduling: vi.fn(),
      resumeScheduling,
      inspect: inspectors(),
      nowMs: () => nowMs,
      createSuspensionId: () => "suspension-delayed-expiry",
    });

    nowMs += SUSPEND_TTL_MS;

    expect(getGatewaySuspendStatus("suspension-delayed-expiry")).toEqual({ status: "running" });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });
});
