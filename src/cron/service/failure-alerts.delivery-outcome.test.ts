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

/** Mirrors the production order: request/persist first, dispatch the notify later. */
async function requestAndDispatchFailureAlert(
  state: CronServiceState,
  storePath: string,
  job: CronJob,
): Promise<void> {
  const deferred: Array<() => void> = [];
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
    deferredNotifications: deferred,
  });
  // The finalization pipeline persists the requested alert state before the
  // deferred notification dispatches the detached send.
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  for (const notify of deferred) {
    notify();
  }
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
    await requestAndDispatchFailureAlert(state, store.storePath, job);

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
    await requestAndDispatchFailureAlert(state, store.storePath, job);

    await vi.waitFor(async () => {
      expect((await readStoredJob(store.storePath))?.state).toMatchObject({
        lastFailureNotificationDelivered: false,
        lastFailureNotificationDeliveryStatus: "not-delivered",
        lastFailureNotificationDeliveryError: "send failed",
      });
    });
    expect(enqueueCronNotification).toHaveBeenCalledWith(
      state,
      expect.objectContaining({ id: job.id }),
      expect.any(String),
      "failure-alert",
    );
  });

  it("retains delivery when the recipient was reached and the transport then rejects", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-reached-then-threw");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createOutcomeState(store.storePath, job, async (params) => {
      params.onDeliveryAttempt?.(true);
      throw new Error("transport died after admission");
    });
    await requestAndDispatchFailureAlert(state, store.storePath, job);

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
    await requestAndDispatchFailureAlert(state, store.storePath, job);

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
    await requestAndDispatchFailureAlert(state, store.storePath, job);

    await vi.waitFor(async () => {
      expect((await readStoredJob(store.storePath))?.state).toMatchObject({
        lastFailureNotificationDelivered: false,
        lastFailureNotificationDeliveryStatus: "not-delivered",
      });
    });
  });

  it("does not overwrite the audit record once a newer alert attempt superseded it", async () => {
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

    const deferred: Array<() => void> = [];
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
      deferredNotifications: deferred,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    // A newer alert attempt replaces the pending outcome before the old send settles.
    const newerAttempt = structuredClone(job);
    newerAttempt.state.lastFailureAlertAtMs = (job.state.lastFailureAlertAtMs ?? 0) + 5_000;
    newerAttempt.state.lastFailureNotificationAttemptId = "newer-attempt";
    newerAttempt.state.lastFailureNotificationDeliveryStatus = "unknown";
    await saveCronStore(store.storePath, { version: 1, jobs: [newerAttempt] });

    for (const notify of deferred) {
      notify();
    }
    settleSend?.();
    await Promise.resolve();
    await Promise.resolve();

    expect((await readStoredJob(store.storePath))?.state).toMatchObject({
      lastFailureAlertAtMs: newerAttempt.state.lastFailureAlertAtMs,
      lastFailureNotificationAttemptId: "newer-attempt",
      lastFailureNotificationDeliveryStatus: "unknown",
    });
  });

  it("does not overwrite fields reset by a later cooldown-suppressed run", async () => {
    const store = fixtures.makeStorePath();
    const job = makeFailureAlertJob("outcome-suppressed-reset");
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

    const deferred: Array<() => void> = [];
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
      deferredNotifications: deferred,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    // A later failed run inside the cooldown window resets the notification
    // fields without dispatching a new alert.
    const suppressed = structuredClone(job);
    suppressed.state.lastFailureNotificationDelivered = undefined;
    suppressed.state.lastFailureNotificationDeliveryStatus = "not-requested";
    suppressed.state.lastFailureNotificationDeliveryError = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [suppressed] });

    for (const notify of deferred) {
      notify();
    }
    settleSend?.();
    await Promise.resolve();
    await Promise.resolve();

    expect((await readStoredJob(store.storePath))?.state).toMatchObject({
      lastFailureNotificationDeliveryStatus: "not-requested",
    });
  });
});
