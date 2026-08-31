import { describe, expect, it, vi } from "vitest";
import { reloadTaskRegistryFromStore } from "../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CronService } from "./service.js";
import { createNoopLogger, installCronTestHooks } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

const BASE_TIME_ISO = "2026-01-15T13:55:00.000Z";
const logger = createNoopLogger();

installCronTestHooks({ logger, baseTimeIso: BASE_TIME_ISO });

function createService(params: {
  storePath: string;
  enqueueSystemEvent?: CronServiceDeps["enqueueSystemEvent"];
  requestHeartbeat?: CronServiceDeps["requestHeartbeat"];
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  onEvent?: CronServiceDeps["onEvent"];
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: params.enqueueSystemEvent ?? vi.fn(),
    requestHeartbeat: params.requestHeartbeat ?? vi.fn(),
    runIsolatedAgentJob:
      params.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}

describe("cron state contracts", () => {
  it("persists create, edit, restart, scheduled execution, and removal across schedule types", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-state-lifecycle-" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        const storePath = state.path("cron", "jobs.json");
        const baseTimeMs = Date.parse(BASE_TIME_ISO);
        const atMs = baseTimeMs + 1_000;
        const enqueueSystemEvent = vi.fn();
        const requestHeartbeat = vi.fn();
        let first: CronService | undefined;
        let restarted: CronService | undefined;
        let reloaded: CronService | undefined;

        try {
          first = createService({ storePath, enqueueSystemEvent, requestHeartbeat });
          await first.start();

          const atJob = await first.add({
            id: "state-contract-at",
            name: "one-shot lifecycle",
            enabled: true,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "state contract fired" },
          });
          const everyJob = await first.add({
            id: "state-contract-every",
            name: "interval lifecycle",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "interval fired" },
          });
          const timezoneJob = await first.add({
            id: "state-contract-timezone",
            name: "timezone lifecycle",
            enabled: true,
            schedule: {
              kind: "cron",
              expr: "0 9 * * *",
              tz: "America/New_York",
              staggerMs: 30_000,
            },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "timezone fired" },
          });

          const updatedEvery = await first.update(everyJob.id, {
            name: "edited interval lifecycle",
            schedule: { kind: "every", everyMs: 120_000 },
          });
          expect(updatedEvery.name).toBe("edited interval lifecycle");
          expect(updatedEvery.schedule).toMatchObject({ kind: "every", everyMs: 120_000 });

          const newYorkNineAm = Date.parse("2026-01-15T14:00:00.000Z");
          expect(timezoneJob.schedule).toEqual({
            kind: "cron",
            expr: "0 9 * * *",
            tz: "America/New_York",
            staggerMs: 30_000,
          });
          expect(timezoneJob.state.nextRunAtMs).toBeGreaterThanOrEqual(newYorkNineAm);
          expect(timezoneJob.state.nextRunAtMs).toBeLessThan(newYorkNineAm + 30_000);

          expect((await loadCronStore(storePath)).jobs.map((job) => job.id).toSorted()).toEqual([
            atJob.id,
            everyJob.id,
            timezoneJob.id,
          ]);

          first.stop();
          first = undefined;

          restarted = createService({ storePath, enqueueSystemEvent, requestHeartbeat });
          await restarted.start();
          const afterRestart = await restarted.list({ includeDisabled: true });
          expect(afterRestart).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: atJob.id,
                schedule: { kind: "at", at: new Date(atMs).toISOString() },
              }),
              expect.objectContaining({
                id: everyJob.id,
                name: "edited interval lifecycle",
                schedule: expect.objectContaining({ kind: "every", everyMs: 120_000 }),
              }),
              expect.objectContaining({
                id: timezoneJob.id,
                schedule: {
                  kind: "cron",
                  expr: "0 9 * * *",
                  tz: "America/New_York",
                  staggerMs: 30_000,
                },
              }),
            ]),
          );

          await vi.advanceTimersByTimeAsync(1_005);
          await restarted.status();

          expect(
            enqueueSystemEvent.mock.calls.filter(([text]) => text === "state contract fired"),
          ).toHaveLength(1);
          expect(
            (await loadCronStore(storePath)).jobs.find((job) => job.id === atJob.id),
          ).toMatchObject({
            enabled: false,
            state: { lastRunStatus: "ok", lastRunAtMs: atMs },
          });

          expect(await restarted.remove(atJob.id)).toEqual({ ok: true, removed: true });
          restarted.stop();
          restarted = undefined;

          reloaded = createService({ storePath, enqueueSystemEvent, requestHeartbeat });
          await reloaded.start();
          expect(
            (await reloaded.list({ includeDisabled: true })).map((job) => job.id).toSorted(),
          ).toEqual([everyJob.id, timezoneJob.id]);
        } finally {
          first?.stop();
          restarted?.stop();
          reloaded?.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  });

  it("deduplicates isolated scheduler execution and persisted run history across reload", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-state-dedup-" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        const storePath = state.path("cron", "jobs.json");
        const atMs = Date.parse(BASE_TIME_ISO) + 1_000;
        const runIsolatedAgentJob = vi.fn(async () => ({
          status: "ok" as const,
          summary: "isolated state contract completed",
        }));
        const events: Array<{ action: string; jobId: string }> = [];
        const onEvent: CronServiceDeps["onEvent"] = (event) => {
          events.push({ action: event.action, jobId: event.jobId });
        };
        let first: CronService | undefined;
        let second: CronService | undefined;
        let restarted: CronService | undefined;

        try {
          first = createService({ storePath, runIsolatedAgentJob, onEvent });
          await first.start();
          const job = await first.add({
            id: "state-contract-isolated-dedup",
            name: "isolated dedup lifecycle",
            enabled: true,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "prove isolated cron state" },
            delivery: { mode: "none" },
          });

          second = createService({ storePath, runIsolatedAgentJob, onEvent });
          await second.start();

          await vi.advanceTimersByTimeAsync(1_005);
          await first.status();
          await second.status();

          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
          expect(
            events.filter((event) => event.jobId === job.id && event.action === "finished"),
          ).toHaveLength(1);

          const initialHistory = readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(storePath),
            jobId: job.id,
          });
          expect(initialHistory.total).toBe(1);
          expect(initialHistory.entries).toEqual([
            expect.objectContaining({
              jobId: job.id,
              status: "ok",
              summary: "isolated state contract completed",
              runAtMs: atMs,
            }),
          ]);
          const persistedEntry = initialHistory.entries[0];

          first.stop();
          first = undefined;
          second.stop();
          second = undefined;
          resetTaskRegistryForTests({ persist: false });
          reloadTaskRegistryFromStore();

          const reloadedHistory = readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(storePath),
            jobId: job.id,
          });
          expect(reloadedHistory.entries).toEqual([persistedEntry]);

          restarted = createService({ storePath, runIsolatedAgentJob, onEvent });
          await restarted.start();
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
          expect(
            readCronTaskRunHistoryPage({
              storeKey: cronStoreKey(storePath),
              jobId: job.id,
            }).entries,
          ).toEqual([persistedEntry]);
        } finally {
          first?.stop();
          second?.stop();
          restarted?.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  });
});
