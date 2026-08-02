// Regression: upstream commit 7d1575b5df (#60310, 2026-04-04) introduced
// activeJobIds + markCronJobActive/clearCronJobActive but only wired the pair
// into the scheduled due-job path. The manual-run path (cron.run() →
// prepareManualRun + finishPreparedManualRun in src/cron/service/ops-run.ts) was
// left without the mark/clear pair, so task-registry.maintenance.ts
// hasBackingSession (cron branch under isRuntimeAuthoritative()=true)
// returns false during manual-run executions and reconciles them as `lost`
// after TASK_RECONCILE_GRACE_MS (5 min).
//
// The merged commit 1fae716a04 (resolveDurableCronTaskRecovery) reconciles
// terminal status retroactively from cron history + store.lastRunStatus, but
// only after the run finishes. This test asserts the producer-side mark/clear
// pair so the transient `lost` marker plus `Background task lost` system
// message is suppressed for long manual runs (force-mode `agentTurn` runs can
// reach AGENT_TURN_SAFETY_TIMEOUT_MS = 60 min).
//
// Production hot-path: cron.run("<id>", "force") direct invocation, the same
// surface used by the `openclaw cron run` CLI / RPC and agent tools. No
// internal-API rerouting (e.g. deferAgentTurnJobs:false) — the test exercises
// the same `prepareManualRun` → `finishPreparedManualRun` chain that hits
// production callers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  isCronActiveJobMarkerCurrent,
  isCronJobActive,
  markCronJobActive,
  resetCronActiveJobs,
} from "./active-jobs.js";
import { CronService } from "./service.js";
import {
  createDeferred,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { clearManualCronJobActive, markManualCronJobActive } from "./service/ops-shared.js";
import { createCronServiceState } from "./service/state.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-active-jobs-manual-run-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

type IsolatedRunResult = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof CronService>[0]["runIsolatedAgentJob"]>>
>;

function createManualIsolatedJob(id: string): CronJob {
  const now = Date.parse("2025-12-13T17:00:00.000Z");
  return {
    id,
    name: id.replaceAll("-", " "),
    enabled: true,
    createdAtMs: now - 3_600_000,
    updatedAtMs: now,
    schedule: { kind: "cron", expr: "0 18 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hi" },
    delivery: { mode: "none" },
    state: {
      nextRunAtMs: now + 3_600_000,
    },
  };
}

async function createManualRunHarness(jobId: string, deliveryRequested = false) {
  const store = await makeStorePath();
  const job = createManualIsolatedJob(jobId);
  if (deliveryRequested) {
    job.delivery = { mode: "announce", channel: "telegram", to: "123" };
  }
  await writeCronStoreSnapshot({
    storePath: store.storePath,
    jobs: [job],
  });

  const entered = createDeferred<void>();
  const release = createDeferred<IsolatedRunResult>();
  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: () => {},
    requestHeartbeat: () => {},
    runIsolatedAgentJob: async () => {
      entered.resolve();
      return await release.promise;
    },
  });
  return { cron, entered, release, store };
}

describe("cron activeJobIds — manual-run mark/clear", () => {
  beforeEach(() => {
    resetCronActiveJobs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["operator", "stream", "exit"] as const)(
    "preserves the %s run origin only while its invocation is active",
    async (executionOrigin) => {
      const jobId = `manual-isolated-${executionOrigin}`;
      const deliveryRequested = executionOrigin !== "operator";
      const { cron, entered, release, store } = await createManualRunHarness(
        jobId,
        deliveryRequested,
      );
      const deliveryError =
        "cron delivery skipped because execution began after its scheduled window";

      try {
        await cron.start();

        const runPromise =
          executionOrigin === "operator"
            ? cron.run(jobId, "force")
            : cron.run(jobId, "force", { executionOrigin });
        await entered.promise;

        expect(isCronJobActive(jobId)).toBe(true);
        expect(cron.resolveRunExecution(jobId)).toMatchObject({
          origin: executionOrigin,
          reservationAt: expect.any(Number),
        });

        release.resolve({
          status: "ok",
          summary: "ok",
          ...(deliveryRequested
            ? { delivered: false, deliveryAttempted: true, deliveryError }
            : {}),
        });
        await runPromise;

        expect(isCronJobActive(jobId)).toBe(false);
        expect(cron.resolveRunExecution(jobId)).toEqual({ origin: "scheduled" });
        if (deliveryRequested) {
          expect(cron.getJob(jobId)?.state).toMatchObject({
            lastRunStatus: "ok",
            lastDeliveryStatus: "not-delivered",
            lastDeliveryError: deliveryError,
            lastFailureNotificationDeliveryStatus: "not-requested",
            consecutiveErrors: 0,
          });
          expect(cron.getJob(jobId)?.state.lastFailureAlertAtMs).toBeUndefined();
        }
      } finally {
        cron.stop();
        await store.cleanup();
      }
    },
  );

  it("does not let old restart-lifecycle finalizers clear new active markers", () => {
    const oldMarker = markCronJobActive("manual-generation-reuse");

    advanceCronActiveJobGeneration();
    const freshMarker = markCronJobActive("manual-generation-reuse");

    clearCronJobActive("manual-generation-reuse", oldMarker);

    expect(isCronJobActive("manual-generation-reuse")).toBe(true);

    clearCronJobActive("manual-generation-reuse", freshMarker);

    expect(isCronJobActive("manual-generation-reuse")).toBe(false);
  });

  it("does not let same-generation finalizers clear replacement active markers", () => {
    const oldMarker = markCronJobActive("manual-token-reuse");
    const freshMarker = markCronJobActive("manual-token-reuse");

    clearCronJobActive("manual-token-reuse", oldMarker);

    expect(isCronJobActive("manual-token-reuse")).toBe(true);

    clearCronJobActive("manual-token-reuse", freshMarker);

    expect(isCronJobActive("manual-token-reuse")).toBe(false);
  });

  it.each(["same-generation", "restart-generation"] as const)(
    "keeps the replacement run origin when a %s finalizer retires an old marker",
    (replacement) => {
      const state = createCronServiceState({
        storePath: "/unused/cron-origin-test.sqlite",
        cronEnabled: false,
        log: logger,
        enqueueSystemEvent: () => {},
        requestHeartbeat: () => {},
        runIsolatedAgentJob: async () => ({ status: "ok" }),
      });
      const job = createManualIsolatedJob("manual-origin-replacement");
      const oldReservationAt = Date.now();
      const oldMarker = markManualCronJobActive(state, job, "operator", oldReservationAt);
      if (replacement === "restart-generation") {
        advanceCronActiveJobGeneration();
      }
      const freshReservationAt = oldReservationAt + 1;
      const freshMarker = markManualCronJobActive(state, job, "stream", freshReservationAt);
      state.manualSetupTimeoutNotified = true;

      clearManualCronJobActive(state, job.id, oldMarker);

      expect(state.activeRunOrigins.get(job.id)?.origin).toBe("stream");
      expect(state.activeRunOrigins.get(job.id)?.reservationAt).toBe(freshReservationAt);
      expect(state.manualSetupTimeoutNotified).toBe(true);
      expect(isCronJobActive(job.id)).toBe(true);

      clearManualCronJobActive(state, job.id, freshMarker);

      expect(state.activeRunOrigins.has(job.id)).toBe(false);
      expect(state.manualSetupTimeoutNotified).toBe(false);
      expect(isCronJobActive(job.id)).toBe(false);
    },
  );

  it.each(["generation advance", "global marker reset"] as const)(
    "does not expose a retired isolated operator after %s before its finalizer runs",
    async (retirement) => {
      const jobId = "retired-manual-operator-origin";
      const { cron, entered, release, store } = await createManualRunHarness(jobId);

      try {
        await cron.start();
        const staleRun = cron.run(jobId, "force");
        await entered.promise;
        expect(cron.resolveRunExecution(jobId).origin).toBe("operator");

        if (retirement === "generation advance") {
          advanceCronActiveJobGeneration();
        } else {
          resetCronActiveJobs();
        }

        expect(cron.resolveRunExecution(jobId)).toEqual({ origin: "scheduled" });
        release.resolve({ status: "ok", summary: "retired" });
        await staleRun;
      } finally {
        cron.stop();
        await store.cleanup();
      }
    },
  );

  it("preserves the real main-session operator invocation across generation advance", async () => {
    const store = await makeStorePath();
    const job = {
      ...createManualIsolatedJob("preserved-main-operator-origin"),
      sessionTarget: "main" as const,
      wakeMode: "now" as const,
      payload: { kind: "systemEvent" as const, text: "operator-owned wake" },
    };
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [job] });
    const heartbeatStarted = createDeferred();
    const releaseHeartbeat = createDeferred();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runHeartbeatOnce: async () => {
        heartbeatStarted.resolve();
        await releaseHeartbeat.promise;
        return { status: "ran", durationMs: 1 };
      },
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    let run: Promise<unknown> | undefined;

    try {
      await cron.start();
      run = cron.run(job.id, "force");
      await heartbeatStarted.promise;

      advanceCronActiveJobGeneration();

      expect(cron.resolveRunExecution(job.id)).toMatchObject({ origin: "operator" });
      resetCronActiveJobs();
      expect(cron.resolveRunExecution(job.id)).toEqual({ origin: "scheduled" });
    } finally {
      releaseHeartbeat.resolve();
      if (run) {
        await run;
      }
      cron.stop();
      await store.cleanup();
    }
  });

  it("retires preserved main-session markers at the lifecycle cutoff", () => {
    const marker = markCronJobActive("manual-main-cutoff", {
      preserveAcrossGenerationAdvance: true,
    });

    advanceCronActiveJobGeneration();

    expect(isCronActiveJobMarkerCurrent(marker)).toBe(true);

    resetCronActiveJobs();

    expect(isCronActiveJobMarkerCurrent(marker)).toBe(false);
    expect(isCronJobActive("manual-main-cutoff")).toBe(false);
  });

  it("clears the active marker even when the inner agent run throws", async () => {
    const { cron, entered, release, store } = await createManualRunHarness("manual-isolated-throw");

    try {
      await cron.start();

      const runPromise = cron.run("manual-isolated-throw", "force");
      await entered.promise;

      expect(isCronJobActive("manual-isolated-throw")).toBe(true);

      release.reject(new Error("synthetic inner failure"));
      await runPromise;

      expect(isCronJobActive("manual-isolated-throw")).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("sends one setup-timeout notification when concurrent manual runs both stall before runner start", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2025-12-13T17:00:00.000Z");
    vi.setSystemTime(now);

    const store = await makeStorePath();
    const firstJob = createManualIsolatedJob("manual-setup-timeout-first");
    const secondJob = createManualIsolatedJob("manual-setup-timeout-second");
    firstJob.payload = { kind: "agentTurn", message: "hi", timeoutSeconds: 120 };
    secondJob.payload = { kind: "agentTurn", message: "hi", timeoutSeconds: 120 };
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [firstJob, secondJob],
    });

    const bothStarted = createDeferred<void>();
    const onIsolatedAgentSetupTimeout = vi.fn();
    let startedCount = 0;
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: async ({ abortSignal }) => {
        startedCount += 1;
        if (startedCount === 2) {
          bothStarted.resolve();
        }
        abortSignal?.addEventListener("abort", () => undefined, { once: true });
        return await new Promise<never>(() => {});
      },
    });

    try {
      await cron.start();

      const firstRun = cron.run(firstJob.id, "force");
      const secondRun = cron.run(secondJob.id, "force");
      await bothStarted.promise;

      await vi.advanceTimersByTimeAsync(60_100);
      await Promise.all([firstRun, secondRun]);

      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
        job: expect.objectContaining({
          id: expect.stringMatching(/^manual-setup-timeout-/),
        }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
      expect(isCronJobActive(firstJob.id)).toBe(false);
      expect(isCronJobActive(secondJob.id)).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
