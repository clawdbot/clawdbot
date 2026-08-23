// Retry-decision tests preserve provider classifications before cron message matching.
import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";
import { applyJobResult } from "./timer-outcomes.js";
import { resolveTransientCronRetryDecision } from "./timer-trigger.js";

describe("resolveTransientCronRetryDecision", () => {
  describe.each(["at", "every"] as const)("%s job completion", (scheduleKind) => {
    it.each([
      "529 lines of output",
      "529 files missing",
      "529 workers failed",
      "process exited with 529 lines of output",
      "ENOENT: no such file '/var/run/app-529.sock'",
    ])("does not retry incidental numeric command failure %s", async (error) => {
      const startedAt = Date.parse("2026-08-20T12:00:00.000Z");
      const endedAt = startedAt + 500;
      const job = makeCronJob({
        payload: { kind: "command", argv: ["local-task"] },
        schedule:
          scheduleKind === "at"
            ? { kind: "at", at: new Date(startedAt).toISOString() }
            : { kind: "every", everyMs: 60 * 60_000, anchorMs: startedAt },
        state: { runningAtMs: startedAt, nextRunAtMs: startedAt },
      });
      const state = createCronServiceState({
        storePath: `/tmp/cron-incidental-${scheduleKind}.json`,
        cronEnabled: true,
        log: createNoopLogger(),
        nowMs: () => endedAt,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runCommandJob: vi.fn(async () => ({
          status: "error" as const,
          error,
          errorClassification: { kind: "permanent" as const },
        })),
      });
      state.store = { version: 1, jobs: [job] };

      const result = await executeJobCore(state, job);
      applyJobResult(state, job, {
        ...result,
        executionStarted: true,
        startedAt,
        endedAt,
      });

      expect(job.state.lastErrorReason).toBeUndefined();
      expect(job.enabled).toBe(scheduleKind === "every");
      expect(job.state.nextRunAtMs).toBe(
        scheduleKind === "every" ? startedAt + 60 * 60_000 : undefined,
      );
    });
  });

  describe.each(["at", "every"] as const)("%s provider job completion", (scheduleKind) => {
    it.each(["HTTP 529", "529 API is busy", "529 Please try again", "529"])(
      "retries provider-attributed overload %s",
      async (error) => {
        const startedAt = Date.parse("2026-08-20T12:00:00.000Z");
        const endedAt = startedAt + 500;
        const job = makeCronJob({
          schedule:
            scheduleKind === "at"
              ? { kind: "at", at: new Date(startedAt).toISOString() }
              : { kind: "every", everyMs: 60 * 60_000, anchorMs: startedAt },
          state: { runningAtMs: startedAt, nextRunAtMs: startedAt },
        });
        const state = createCronServiceState({
          storePath: "/tmp/cron-provider-overload.json",
          cronEnabled: true,
          log: createNoopLogger(),
          nowMs: () => endedAt,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({
            status: "error" as const,
            error,
            provider: "provider-fixture",
          })),
        });
        state.store = { version: 1, jobs: [job] };

        applyJobResult(state, job, {
          ...(await executeJobCore(state, job)),
          executionStarted: true,
          startedAt,
          endedAt,
        });

        expect(job.state.lastErrorReason).toBe("overloaded");
        expect(job.enabled).toBe(true);
        expect(job.state.nextRunAtMs).toBe(endedAt + 30_000);
      },
    );
  });

  it("keeps permanent-looking and transient provider classifications distinct", () => {
    const error = "HTTP 429: all available credits have been exhausted";

    expect(
      resolveTransientCronRetryDecision({
        error,
        errorClassification: { kind: "reason", reason: "billing" },
        consecutiveErrors: 1,
      }),
    ).toEqual({
      retryable: false,
      consecutiveErrors: 1,
      reason: "permanent error",
    });

    expect(
      resolveTransientCronRetryDecision({
        error,
        errorClassification: { kind: "reason", reason: "rate_limit" },
        consecutiveErrors: 1,
      }),
    ).toMatchObject({
      retryable: true,
      consecutiveErrors: 1,
      retryCategory: "rate_limit",
      reason: "transient retry",
    });
  });
});
