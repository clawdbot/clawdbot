import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HeartbeatRunOptions } from "../../infra/heartbeat-runner-execution.js";
import {
  resolveHeartbeatPreflight,
  resolveHeartbeatRunPrompt,
} from "../../infra/heartbeat-runner-prompt.js";
import { startHeartbeatRunner } from "../../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeat as requestHeartbeatWake } from "../../infra/heartbeat-wake.js";
import {
  drainSystemEvents,
  enqueueSystemEvent as queueSystemEvent,
} from "../../infra/system-events.js";
import * as cronSchedule from "../schedule.js";
import type { CronJob } from "../types.js";
import { markInterruptedStartupRun, restoreFinalizedStartupRun } from "./startup-run-repair.js";
import { createCronServiceState } from "./state.js";

describe("startup run repair auto-disable", () => {
  it("records the tenth restart-interrupted recurring failure before notification", () => {
    const runningAtMs = Date.parse("2026-08-01T16:00:00.000Z");
    const nowMs = runningAtMs + 30_000;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      storePath: "/tmp/startup-run-repair-auto-disable.json",
      cronEnabled: true,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      nowMs: () => nowMs,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(),
    });
    const job: CronJob = {
      id: "restart-auto-disable",
      name: "restart auto-disable",
      enabled: true,
      createdAtMs: runningAtMs - 60_000,
      updatedAtMs: runningAtMs,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: runningAtMs - 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "do not replay" },
      state: {
        nextRunAtMs: runningAtMs,
        runningAtMs,
        consecutiveErrors: 9,
        lastErrorReason: "timeout",
        deliverySuppressionReason: "silent",
      },
    };
    const deferredNotifications: Array<() => void> = [];

    markInterruptedStartupRun({
      state,
      job,
      runningAtMs,
      nowMs,
      deferredNotifications,
    });

    expect(job).toMatchObject({
      enabled: false,
      state: {
        consecutiveErrors: 10,
        autoDisabled: {
          reason: "consecutive-failures",
          atMs: nowMs,
          consecutiveErrors: 10,
        },
      },
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(job.state.deliverySuppressionReason).toBeUndefined();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(deferredNotifications).toHaveLength(1);

    deferredNotifications[0]?.();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).toContain(
      "Check automation history for details.",
    );
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).not.toContain("timeout");
    expect(requestHeartbeat).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "the default owner",
      creatorSessionKey: undefined,
      executionSessionTarget: "isolated" as const,
    },
    {
      name: "its creator instead of a different execution conversation",
      creatorSessionKey: "agent:main:telegram:group:42:topic:77",
      executionSessionTarget: "session:agent:main:telegram:group:99" as const,
    },
  ])("delivers an auto-disable safety notice to $name with cadence disabled", async (testCase) => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-08-01T16:00:00.000Z");
    vi.setSystemTime(nowMs);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "0m" } },
        list: [{ id: "main" }, { id: "other" }],
      },
    };
    const sessionKey =
      testCase.creatorSessionKey ?? resolveAgentMainSessionKey({ cfg, agentId: "main" });
    const prompts: string[] = [];
    const runOnce = vi.fn(async (options: HeartbeatRunOptions) => {
      const preflight = await resolveHeartbeatPreflight({
        cfg,
        agentId: "main",
        sessionKey: options.sessionKey,
        heartbeat: options.heartbeat,
        source: options.source,
        reason: options.reason,
      });
      prompts.push(
        resolveHeartbeatRunPrompt({
          cfg,
          preflight,
          canRelayToUser: true,
          startedAt: nowMs,
          scheduledTasks: [],
          useHeartbeatResponseTool: false,
        }).prompt,
      );
      return { status: "ran" as const, durationMs: 1 };
    });
    const runner = startHeartbeatRunner({
      cfg,
      readCurrentConfig: () => cfg,
      runOnce,
    });
    try {
      const state = createCronServiceState({
        storePath: "/tmp/startup-run-repair-auto-disable-notification.json",
        cronEnabled: true,
        defaultAgentId: "main",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nowMs: () => nowMs,
        enqueueSystemEvent: (text, options) =>
          queueSystemEvent(text, {
            sessionKey: options?.sessionKey ?? sessionKey,
            contextKey: options?.contextKey,
          }),
        requestHeartbeat: (wake) =>
          requestHeartbeatWake({
            ...wake,
            sessionKey: wake.sessionKey ?? sessionKey,
            coalesceMs: 0,
          }),
        runIsolatedAgentJob: vi.fn(),
      });
      const job: CronJob = {
        id: "restart-auto-disable-notification",
        name: "Important report",
        agentId: "main",
        enabled: true,
        createdAtMs: nowMs - 60_000,
        updatedAtMs: nowMs,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs - 60_000 },
        sessionTarget: testCase.executionSessionTarget,
        ...(testCase.creatorSessionKey ? { sessionKey: testCase.creatorSessionKey } : {}),
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "check important report" },
        state: { runningAtMs: nowMs, consecutiveErrors: 9 },
      };
      const deferredNotifications: Array<() => void> = [];

      markInterruptedStartupRun({
        state,
        job,
        runningAtMs: nowMs,
        nowMs,
        deferredNotifications,
      });
      expect(job.sessionKey).toBe(testCase.creatorSessionKey);
      expect(deferredNotifications).toHaveLength(1);
      deferredNotifications[0]?.();
      await vi.advanceTimersByTimeAsync(1);

      expect(runOnce).toHaveBeenCalledOnce();
      expect(runOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey,
          source: "notifications-event",
          intent: "immediate",
          reason: "wake",
        }),
      );
      expect(prompts[0]).toContain('Automation "Important report" was auto-disabled');
      expect(prompts[0]).toContain("10 consecutive run failures");
      expect(prompts[0]).toContain("openclaw automations enable restart-auto-disable-notification");
      expect(prompts[0]).toContain("Please relay this reminder to the user");
    } finally {
      runner.stop();
      drainSystemEvents(sessionKey);
      vi.useRealTimers();
    }
  });

  it("disables a job instead of restoring an invalid finalized next run", () => {
    const runningAtMs = Date.parse("2026-08-01T16:00:00.000Z");
    const state = createCronServiceState({
      storePath: "/tmp/startup-run-repair-invalid-next-run.json",
      cronEnabled: true,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      nowMs: () => runningAtMs + 1_000,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const job: CronJob = {
      id: "invalid-finalized-next-run",
      name: "invalid finalized next run",
      enabled: true,
      createdAtMs: runningAtMs - 60_000,
      updatedAtMs: runningAtMs,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: runningAtMs - 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "do not replay" },
      state: { nextRunAtMs: runningAtMs, runningAtMs },
    };
    const deferredNotifications: Array<() => void> = [];

    restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs,
      deferredNotifications,
      entry: {
        ts: runningAtMs + 1_000,
        jobId: job.id,
        action: "finished",
        status: "ok",
        runAtMs: runningAtMs,
        durationMs: 1_000,
        nextRunAtMs: MAX_DATE_TIMESTAMP_MS + 1,
      },
    });

    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.autoDisabled).toEqual({
      reason: "schedule-errors",
      atMs: runningAtMs + 1_000,
      consecutiveErrors: 1,
    });
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
    expect(deferredNotifications).toHaveLength(1);

    deferredNotifications[0]?.();
    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(state.deps.requestHeartbeat).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "required delivery failed",
      completionStatus: "failed" as const,
      deliveryStatus: "not-delivered" as const,
      failureNotificationDelivery: { status: "delivered" as const, delivered: true },
    },
    {
      name: "completion evidence unknown",
      completionStatus: "unknown" as const,
      deliveryStatus: "unknown" as const,
    },
    {
      name: "legacy row missing completion evidence",
      completionStatus: undefined,
      deliveryStatus: "not-delivered" as const,
    },
    {
      name: "best-effort undelivered completion followed by a delivery mode edit",
      completionStatus: "succeeded" as const,
      deliveryStatus: "not-delivered" as const,
      deliveryMode: "none" as const,
    },
    {
      name: "best-effort unknown completion followed by a delivery mode edit",
      completionStatus: "succeeded" as const,
      deliveryStatus: "unknown" as const,
      deliveryMode: "none" as const,
    },
  ])("applies recorded completion to one-shot cleanup after $name", (testCase) => {
    const { completionStatus, deliveryStatus } = testCase;
    const failureNotificationDelivery =
      "failureNotificationDelivery" in testCase ? testCase.failureNotificationDelivery : undefined;
    const runningAtMs = Date.parse("2026-08-01T17:00:00.000Z");
    const deferredNotifications: Array<() => void> = [];
    const state = createCronServiceState({
      storePath: "/tmp/startup-run-repair-completion.json",
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => runningAtMs + 1_000,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      sendCronFailureAlert: vi.fn(async () => undefined),
    });
    const job: CronJob = {
      id: "finalized-required-delivery",
      name: "finalized required delivery",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: runningAtMs - 60_000,
      updatedAtMs: runningAtMs,
      schedule: { kind: "at", at: new Date(runningAtMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do not replay" },
      // Current policy is intentionally mutable and must not decide replay.
      delivery: {
        mode: testCase.deliveryMode ?? "announce",
        bestEffort: true,
      },
      failureAlert: { mode: "webhook", to: "https://alerts.example.test/cron" },
      state: { runningAtMs },
    };

    const restored = restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs,
      deferredNotifications,
      entry: {
        ts: runningAtMs + 1_000,
        jobId: job.id,
        action: "finished",
        status: "ok",
        ...(completionStatus === undefined ? {} : { completionStatus }),
        deliveryStatus,
        failureNotificationDelivery,
        runAtMs: runningAtMs,
        durationMs: 1_000,
      },
    });

    expect(restored?.shouldDelete).toBe(completionStatus === "succeeded");
    expect(job.state).toMatchObject({
      lastRunStatus: "ok",
      consecutiveErrors: 0,
    });
    if (!restored?.shouldDelete) {
      expect(job.enabled).toBe(false);
    }
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(deferredNotifications).toEqual([]);
    expect(state.deps.sendCronFailureAlert).not.toHaveBeenCalled();
    if (failureNotificationDelivery) {
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
      expect(job.state.lastFailureNotificationDelivered).toBe(true);
    }
  });

  it("buffers quiet-trigger repair notifications until the recovery commit", () => {
    const runningAtMs = Date.parse("2026-08-01T16:30:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      storePath: "/tmp/startup-run-repair-quiet-trigger.json",
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => runningAtMs + 1_000,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(),
    });
    const job: CronJob = {
      id: "quiet-trigger-auto-disable",
      name: "quiet trigger auto disable",
      enabled: true,
      createdAtMs: runningAtMs - 60_000,
      updatedAtMs: runningAtMs,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "Invalid/Zone" },
      trigger: { script: "return false" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "do not replay" },
      state: {
        nextRunAtMs: runningAtMs,
        runningAtMs,
        scheduleErrorCount: 2,
      },
    };
    const deferredNotifications: Array<() => void> = [];
    const computeSpy = vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation(() => {
      throw new Error("simulated quiet-trigger schedule failure");
    });

    try {
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs,
        deferredNotifications,
        triggerEval: { fired: false, stateChanged: false, busy: true },
        entry: {
          ts: runningAtMs + 1_000,
          jobId: job.id,
          action: "finished",
          status: "ok",
          runAtMs: runningAtMs,
        },
      });
    } finally {
      computeSpy.mockRestore();
    }

    expect(job.state.autoDisabled?.reason).toBe("schedule-errors");
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(deferredNotifications).toHaveLength(1);
  });

  it.each(["runAtMs", "ts"] as const)(
    "ignores finalized startup history with an invalid %s",
    (field) => {
      const runningAtMs = Date.parse("2026-08-01T16:00:00.000Z");
      const warn = vi.fn();
      const state = createCronServiceState({
        storePath: "/tmp/startup-run-repair-invalid-history.json",
        cronEnabled: true,
        log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
        nowMs: () => runningAtMs + 1_000,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
      });
      const job: CronJob = {
        id: "invalid-finalized-history",
        name: "invalid finalized history",
        enabled: true,
        createdAtMs: runningAtMs - 60_000,
        updatedAtMs: runningAtMs,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "do not replay" },
        state: { nextRunAtMs: runningAtMs, runningAtMs },
      };
      const before = structuredClone(job);

      const result = restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs,
        entry: {
          ts: field === "ts" ? MAX_DATE_TIMESTAMP_MS + 1 : runningAtMs + 1_000,
          jobId: job.id,
          action: "finished",
          status: "ok",
          runAtMs: field === "runAtMs" ? MAX_DATE_TIMESTAMP_MS + 1 : runningAtMs,
          durationMs: 1_000,
        },
      });

      expect(result).toBeUndefined();
      expect(job).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        { jobId: job.id },
        "cron: ignoring finalized startup run with an invalid timestamp envelope",
      );
    },
  );
});
