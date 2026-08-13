import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
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
