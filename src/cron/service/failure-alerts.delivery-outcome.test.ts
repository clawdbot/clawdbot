// Failure-alert send outcomes must be persisted onto the live stored job.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { CronJob } from "../types.js";
import { maybeEmitFailureAlert } from "./failure-alerts.js";
import { createCronServiceState, type CronServiceState } from "./state.js";
import { persist } from "./store.js";
import { enqueueCronNotification } from "./wake.js";

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return { ...actual, persist: vi.fn(async () => {}) };
});

vi.mock("./wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wake.js")>();
  return { ...actual, enqueueCronNotification: vi.fn() };
});

type SendCronFailureAlert = NonNullable<
  Parameters<typeof createCronServiceState>[0]["sendCronFailureAlert"]
>;

function createFailureAlertState(sendCronFailureAlert?: SendCronFailureAlert): CronServiceState {
  return createCronServiceState({
    cronEnabled: true,
    storePath: "unused.jobs.json",
    log: noopLogger,
    nowMs: () => 1_000,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    ...(sendCronFailureAlert ? { sendCronFailureAlert } : {}),
  });
}

function makeFailureAlertJob(id: string): CronJob {
  const job = createDueIsolatedJob({ id, nowMs: 0, nextRunAtMs: 1_000 });
  job.failureAlert = { after: 1, cooldownMs: 60_000 };
  return job;
}

function emitFailureAlertForJob(state: CronServiceState, job: CronJob): void {
  maybeEmitFailureAlert(state, {
    job,
    alertConfig: {
      after: 1,
      cooldownMs: 60_000,
      channel: "last",
      mode: "announce",
      includeSkipped: false,
      alternateRoute: false,
    },
    status: "error",
    error: "job failed",
    consecutiveCount: 1,
  });
}

describe("cron failure alert delivery outcome persistence", () => {
  beforeEach(() => {
    vi.mocked(persist).mockClear();
    vi.mocked(enqueueCronNotification).mockClear();
  });

  it("persists a delivered outcome onto the live stored job", async () => {
    const job = makeFailureAlertJob("job-delivered");
    const state = createFailureAlertState(async (params) => {
      params.onDeliveryAttempt?.(true);
    });
    state.store = { version: 1, jobs: [job] };

    emitFailureAlertForJob(state, job);

    await vi.waitFor(() => {
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
    });
    expect(job.state.lastFailureNotificationDelivered).toBe(true);
    expect(job.state.lastFailureNotificationDeliveryError).toBeUndefined();
    expect(persist).toHaveBeenCalledWith(state);
    expect(enqueueCronNotification).not.toHaveBeenCalled();
  });

  it("persists the error when the alert send throws", async () => {
    const job = makeFailureAlertJob("job-failed-send");
    const state = createFailureAlertState(async () => {
      throw new Error("send failed");
    });
    state.store = { version: 1, jobs: [job] };

    emitFailureAlertForJob(state, job);

    await vi.waitFor(() => {
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe("not-delivered");
    });
    expect(job.state.lastFailureNotificationDelivered).toBe(false);
    expect(job.state.lastFailureNotificationDeliveryError).toBe("send failed");
    expect(enqueueCronNotification).toHaveBeenCalledWith(
      state,
      expect.objectContaining({ id: job.id }),
      expect.any(String),
      "failure-alert",
    );
    expect(persist).toHaveBeenCalledWith(state);
  });

  it("records not-delivered when the send settles without reaching the recipient", async () => {
    const job = makeFailureAlertJob("job-unreached");
    const state = createFailureAlertState(async (params) => {
      params.onDeliveryAttempt?.(false);
    });
    state.store = { version: 1, jobs: [job] };

    emitFailureAlertForJob(state, job);

    await vi.waitFor(() => {
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe("not-delivered");
    });
    expect(job.state.lastFailureNotificationDelivered).toBe(false);
    expect(job.state.lastFailureNotificationDeliveryError).toBeUndefined();
    expect(enqueueCronNotification).toHaveBeenCalled();
  });

  it("records not-delivered when no failure-alert transport is configured", () => {
    const job = makeFailureAlertJob("job-no-transport");
    const state = createFailureAlertState();
    state.store = { version: 1, jobs: [job] };

    emitFailureAlertForJob(state, job);

    expect(job.state.lastFailureNotificationDeliveryStatus).toBe("not-delivered");
    expect(job.state.lastFailureNotificationDelivered).toBe(false);
    expect(enqueueCronNotification).toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith(state);
  });
});
