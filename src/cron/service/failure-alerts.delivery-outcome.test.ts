// Failure-alert send outcomes must commit onto the authoritative cron row.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { maybeEmitFailureAlert } from "./failure-alerts.js";
import { createCronServiceState, type CronServiceState } from "./state.js";
import { enqueueCronNotification } from "./wake.js";

vi.mock("./wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wake.js")>();
  return { ...actual, enqueueCronNotification: vi.fn() };
});

const fixtures = setupCronRegressionFixtures({ prefix: "cron-failure-alert-outcome-" });

type SendCronFailureAlert = NonNullable<
  Parameters<typeof createCronServiceState>[0]["sendCronFailureAlert"]
>;

function makeFailureAlertJob(id: string): CronJob {
  const job = createDueIsolatedJob({ id, nowMs: 0, nextRunAtMs: 1_000 });
  job.failureAlert = { after: 1, cooldownMs: 60_000 };
  return job;
}

function createOutcomeState(
  storePath: string,
  job: CronJob,
  sendCronFailureAlert?: SendCronFailureAlert,
): CronServiceState {
  const state = createCronServiceState({
    cronEnabled: true,
    storePath,
    log: noopLogger,
    nowMs: () => 1_000,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    ...(sendCronFailureAlert ? { sendCronFailureAlert } : {}),
  });
  state.store = { version: 1, jobs: [job] };
  return state;
}

function emitFailureAlert(state: CronServiceState, job: CronJob): void {
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

async function readStoredJob(storePath: string): Promise<CronJob | undefined> {
  return (await loadCronStore(storePath)).jobs[0];
}

describe("cron failure alert delivery outcome persistence", () => {
  it("commits a delivered outcome onto the authoritative row", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-delivered");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createOutcomeState(store.storePath, job, async (params) => {
      params.onDeliveryAttempt?.(true);
    });

    emitFailureAlert(state, job);

    await vi.waitFor(async () => {
      expect((await readStoredJob(store.storePath))?.state).toMatchObject({
        lastFailureNotificationDelivered: true,
        lastFailureNotificationDeliveryStatus: "delivered",
      });
    });
    expect(
      (await readStoredJob(store.storePath))?.state.lastFailureNotificationDeliveryError,
    ).toBeUndefined();
    await vi.waitFor(() => {
      expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
    });
  });

  it("commits the error when the alert send throws without reaching the recipient", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-send-threw");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createOutcomeState(store.storePath, job, async () => {
      throw new Error("send failed");
    });

    emitFailureAlert(state, job);

    await vi.waitFor(async () => {
      expect((await readStoredJob(store.storePath))?.state).toMatchObject({
        lastFailureNotificationDelivered: false,
        lastFailureNotificationDeliveryStatus: "not-delivered",
        lastFailureNotificationDeliveryError: "send failed",
      });
    });
  });

  it("retains delivery when the recipient was reached and the transport then rejects", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-reached-then-threw");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createOutcomeState(store.storePath, job, async (params) => {
      params.onDeliveryAttempt?.(true);
      throw new Error("transport died after admission");
    });

    emitFailureAlert(state, job);

    await vi.waitFor(async () => {
      expect((await readStoredJob(store.storePath))?.state).toMatchObject({
        lastFailureNotificationDelivered: true,
        lastFailureNotificationDeliveryStatus: "delivered",
      });
    });
  });

  it("records not-delivered when the send settles without reaching the recipient", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-unreached");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createOutcomeState(store.storePath, job, async (params) => {
      params.onDeliveryAttempt?.(false);
    });

    emitFailureAlert(state, job);

    await vi.waitFor(async () => {
      expect((await readStoredJob(store.storePath))?.state).toMatchObject({
        lastFailureNotificationDelivered: false,
        lastFailureNotificationDeliveryStatus: "not-delivered",
      });
    });
    expect(
      (await readStoredJob(store.storePath))?.state.lastFailureNotificationDeliveryError,
    ).toBeUndefined();
  });

  it("records not-delivered when no failure-alert transport is configured", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-no-transport");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createOutcomeState(store.storePath, job);

    emitFailureAlert(state, job);

    await vi.waitFor(async () => {
      expect((await readStoredJob(store.storePath))?.state).toMatchObject({
        lastFailureNotificationDelivered: false,
        lastFailureNotificationDeliveryStatus: "not-delivered",
      });
    });
  });

  it("does not overwrite the audit record once a newer alert superseded it", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-superseded");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    let settleSend: (() => void) | undefined;
    const state = createOutcomeState(
      store.storePath,
      job,
      () =>
        new Promise<void>((resolve) => {
          settleSend = resolve;
        }),
    );

    emitFailureAlert(state, job);
    expect(settleSend).toBeTypeOf("function");
    // A newer alert for the same job replaces the pending outcome before the
    // old send settles.
    const supersedingJob = structuredClone(job);
    supersedingJob.state.lastFailureAlertAtMs = (job.state.lastFailureAlertAtMs ?? 0) + 5_000;
    supersedingJob.state.lastFailureNotificationDeliveryStatus = "unknown";
    await saveCronStore(store.storePath, { version: 1, jobs: [supersedingJob] });

    settleSend?.();
    // Let the settled send's microtask chain (the outcome commit) run.
    await Promise.resolve();
    await Promise.resolve();

    expect((await readStoredJob(store.storePath))?.state).toMatchObject({
      lastFailureAlertAtMs: supersedingJob.state.lastFailureAlertAtMs,
      lastFailureNotificationDeliveryStatus: "unknown",
    });
  });
});
