// Finalization-to-durable-state proof: drives the REAL resolveCronPayloadOutcome
// (the cron finalization classifier at run-finalize.ts:251) through the REAL
// shared production finalization mapper resolveCronRunFinalStatus (run-finalize.ts)
// into the REAL finalizeCompletedCronRunOutcomes (timer-outcome-finalization.ts),
// which persists job state and emits the failure alert. No mock stands in for
// the classifier, the finalization mapper, or the persisted timer-state update.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { markCronJobActive } from "../active-jobs.js";
import { resolveCronPayloadOutcome } from "../isolated-agent/helpers.js";
import { resolveCronRunFinalStatus } from "../isolated-agent/run-finalize.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-finalization-streak-",
  baseTimeIso: "2026-08-01T14:50:00.000Z",
});

const DUE_AT = Date.parse("2026-08-01T14:50:00.000Z");
const ENDED_AT = DUE_AT + 10;
const ERROR_PAYLOAD = { text: "⚠️ 🛠️ Exec failed: ENOENT /mnt/d unreachable", isError: true };

type SendCronFailureAlert = NonNullable<
  Parameters<typeof createCronServiceState>[0]["sendCronFailureAlert"]
>;

function makeAlertJob(id: string): CronJob {
  const job = createDueIsolatedJob({ id, nowMs: DUE_AT, nextRunAtMs: DUE_AT });
  job.schedule = { kind: "every", everyMs: 60 * 60_000, anchorMs: DUE_AT - 60_000 };
  // after:1 so a single error run fires the failure alert through the real
  // maybeEmitFailureAlert path (failure-alerts.ts).
  job.failureAlert = { after: 1, cooldownMs: 60_000 };
  job.state.runningAtMs = DUE_AT;
  return job;
}

function makeState(storePath: string, sendCronFailureAlert: SendCronFailureAlert) {
  return createCronServiceState({
    cronEnabled: true,
    storePath,
    log: noopLogger,
    nowMs: () => ENDED_AT,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    sendCronFailureAlert,
    runIsolatedAgentJob: vi.fn(),
  });
}

// Real finalization: classifier -> shared production mapper -> persisted timer
// state + alert. The status is produced by the REAL resolveCronRunFinalStatus,
// not a copied ternary, so the proof tracks the production finalization owner.
async function finalizeSilentReplyRun(
  state: ReturnType<typeof createCronServiceState>,
  job: CronJob,
  silentText: string,
  startedAt = DUE_AT,
  endedAt = ENDED_AT,
) {
  const outcome = resolveCronPayloadOutcome({
    payloads: [ERROR_PAYLOAD],
    finalAssistantVisibleText: silentText,
    preferFinalAssistantVisibleText: true,
  });
  const status = resolveCronRunFinalStatus(outcome);
  await finalizeCompletedCronRunOutcomes(state, [
    {
      jobId: job.id,
      job: structuredClone(job),
      activeJobMarker: markCronJobActive(job.id),
      status,
      error: status === "error" ? outcome.embeddedRunError : undefined,
      startedAt,
      endedAt,
    },
  ]);
  return { outcome, status };
}

describe("cron finalization → durable timer state + failure alert (real classifier + real mapper + real persistence)", () => {
  it.each([
    ["token-only", "NO_REPLY"],
    ["json string", '"NO_REPLY"'],
    ["action envelope", '{"action":"NO_REPLY"}'],
    ["reasoning-prefixed", "<thinking>considered</thinking>NO_REPLY"],
  ])(
    "an error payload plus a %s silent final reply stays fatal, persists consecutiveErrors, and fires the alert (#116731)",
    async (_form, silentText) => {
      const store = fixtures.makeStorePath();
      const job = makeAlertJob(`silent-${_form.replace(/\s+/g, "-")}`);
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = makeState(store.storePath, sendCronFailureAlert);

      const { outcome, status } = await finalizeSilentReplyRun(state, job, silentText);

      // Real classifier + real shared production mapper.
      expect(outcome.hasFatalErrorPayload).toBe(true);
      expect(status).toBe("error");

      // Durable state: reload from the store and assert the persisted streak.
      const reloaded = (await loadCronStore(store.storePath)).jobs[0];
      expect(reloaded?.state.consecutiveErrors).toBe(1);
      expect(reloaded?.state.lastRunStatus).toBe("error");
      // Fired alert: the real maybeEmitFailureAlert recorded the durable alert
      // marker and dispatched sendCronFailureAlert after the terminal write.
      expect(reloaded?.state.lastFailureAlertAtMs).toBe(ENDED_AT);
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    },
  );

  it("a recovering final answer clears the error streak and fires no alert (control)", async () => {
    const store = fixtures.makeStorePath();
    const job = makeAlertJob("silent-recovering-control");
    job.state.consecutiveErrors = 2;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = makeState(store.storePath, sendCronFailureAlert);

    const outcome = resolveCronPayloadOutcome({
      payloads: [ERROR_PAYLOAD],
      finalAssistantVisibleText: "**Daily report**: 34 closed",
      preferFinalAssistantVisibleText: true,
    });
    const status = resolveCronRunFinalStatus(outcome);
    expect(status).toBe("ok");
    await finalizeCompletedCronRunOutcomes(state, [
      {
        jobId: job.id,
        job: structuredClone(job),
        activeJobMarker: markCronJobActive(job.id),
        status,
        startedAt: DUE_AT,
        endedAt: ENDED_AT,
      },
    ]);

    const reloaded = (await loadCronStore(store.storePath)).jobs[0];
    expect(reloaded?.state.consecutiveErrors).toBe(0);
    expect(reloaded?.state.lastRunStatus).toBe("ok");
    expect(reloaded?.state.lastFailureAlertAtMs).toBeUndefined();
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
  });

  it("accumulates the error streak across consecutive silent-reply failures", async () => {
    const store = fixtures.makeStorePath();
    const job = makeAlertJob("silent-streak");
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = makeState(store.storePath, sendCronFailureAlert);

    // Three consecutive silent-reply error runs through the real finalization
    // path. Each call reloads the durable store, so the streak accumulates 1->2->3.
    for (let i = 1; i <= 3; i++) {
      await finalizeSilentReplyRun(state, job, '{"action":"NO_REPLY"}', DUE_AT + i, ENDED_AT + i);
      const reloaded = (await loadCronStore(store.storePath)).jobs[0];
      expect(reloaded?.state.consecutiveErrors).toBe(i);
      expect(reloaded?.state.lastRunStatus).toBe("error");
    }
  });
});
