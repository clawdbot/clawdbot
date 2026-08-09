import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { markInterruptedStartupRun } from "./startup-run-repair.js";
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
    expect(requestHeartbeat).toHaveBeenCalledOnce();
  });
});
