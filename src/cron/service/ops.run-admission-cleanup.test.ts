// Queued cron reservation cleanup regressions across every trigger.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { run, stop } from "./ops.js";
import { createCronServiceState } from "./state.js";
import { runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-cleanup-",
});

describe("cron service run admission cleanup", () => {
  it.each(["manual", "scheduled", "startup"] as const)(
    "does not start a %s run when stop wins the activation write",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const job = createDueIsolatedJob({
        id: `stopped-during-${trigger}-activation`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      job.state.lastError = "prior failure";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
      const realSave = cronStoreModule.saveCronJobsStore;
      let reservationPersisted = false;
      const saveSpy = vi
        .spyOn(cronStoreModule, "saveCronJobsStore")
        .mockImplementation(async (storePath, nextStore, opts) => {
          const nextState = nextStore.jobs.find((entry) => entry.id === job.id)?.state;
          const queuedAtMs = nextState?.queuedAtMs;
          const runningAtMs = nextState?.runningAtMs;
          await realSave(storePath, nextStore, opts);
          if (!reservationPersisted && queuedAtMs === dueAt) {
            reservationPersisted = true;
            now = dueAt + 1;
          } else if (reservationPersisted && runningAtMs === dueAt + 1) {
            stop(state);
          }
        });

      try {
        if (trigger === "manual") {
          await expect(run(state, job.id, "force")).resolves.toEqual({
            ok: true,
            ran: false,
            reason: "stopped",
          });
        } else if (trigger === "scheduled") {
          await onTimer(state);
        } else {
          await runMissedJobs(state);
        }
      } finally {
        saveSpy.mockRestore();
      }

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastError).toBe("prior failure");
    },
  );

  it.each(["manual", "scheduled", "startup"] as const)(
    "retries %s cleanup when stop wins the reservation write",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.250Z");
      const job = createDueIsolatedJob({
        id: `stopped-during-${trigger}-reservation`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => dueAt,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const realSave = cronStoreModule.saveCronJobsStore;
      let reservationPersisted = false;
      let cleanupFailed = false;
      const saveSpy = vi
        .spyOn(cronStoreModule, "saveCronJobsStore")
        .mockImplementation(async (storePath, nextStore, opts) => {
          const nextState = nextStore.jobs.find((entry) => entry.id === job.id)?.state;
          const queuedAtMs = nextState?.queuedAtMs;
          if (reservationPersisted && !cleanupFailed && queuedAtMs === undefined) {
            cleanupFailed = true;
            throw new Error("reservation cleanup persist failed");
          }
          await realSave(storePath, nextStore, opts);
          if (!reservationPersisted && queuedAtMs === dueAt) {
            reservationPersisted = true;
            stop(state);
          }
        });

      try {
        if (trigger === "manual") {
          await expect(run(state, job.id, "force")).resolves.toEqual({
            ok: true,
            ran: false,
            reason: "stopped",
          });
        } else if (trigger === "scheduled") {
          await onTimer(state);
        } else {
          await expect(runMissedJobs(state)).rejects.toThrow("reservation cleanup persist failed");
        }
      } finally {
        saveSpy.mockRestore();
      }

      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
          .runningAtMs,
      ).toBeUndefined();
    },
  );

  it.each(["manual", "scheduled", "startup"] as const)(
    "cleans a %s reservation after activation persistence fails",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.500Z");
      const job = createDueIsolatedJob({
        id: `failed-${trigger}-activation-persist`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      job.state.lastError = "prior failure";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
      const realSave = cronStoreModule.saveCronJobsStore;
      let reservationPersisted = false;
      let activationFailed = false;
      const saveSpy = vi
        .spyOn(cronStoreModule, "saveCronJobsStore")
        .mockImplementation(async (storePath, nextStore, opts) => {
          const nextState = nextStore.jobs.find((entry) => entry.id === job.id)?.state;
          const queuedAtMs = nextState?.queuedAtMs;
          const runningAtMs = nextState?.runningAtMs;
          if (reservationPersisted && !activationFailed && runningAtMs === dueAt + 1) {
            activationFailed = true;
            throw new Error("activation persist failed");
          }
          await realSave(storePath, nextStore, opts);
          if (!reservationPersisted && queuedAtMs === dueAt) {
            reservationPersisted = true;
            now = dueAt + 1;
          }
        });

      try {
        const operation =
          trigger === "manual"
            ? run(state, job.id, "force")
            : trigger === "scheduled"
              ? onTimer(state)
              : runMissedJobs(state);
        await expect(operation).rejects.toThrow("activation persist failed");
      } finally {
        saveSpy.mockRestore();
      }

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastError).toBe("prior failure");
    },
  );

  it.each(["manual", "scheduled", "startup"] as const)(
    "retries %s reservation cleanup after a persistence failure",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.750Z");
      const job = createDueIsolatedJob({
        id: `failed-${trigger}-cleanup-persist`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      job.state.lastError = "prior failure";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
      const realSave = cronStoreModule.saveCronJobsStore;
      let reservationPersisted = false;
      let activationPersisted = false;
      let cleanupFailed = false;
      const saveSpy = vi
        .spyOn(cronStoreModule, "saveCronJobsStore")
        .mockImplementation(async (storePath, nextStore, opts) => {
          const nextState = nextStore.jobs.find((entry) => entry.id === job.id)?.state;
          const queuedAtMs = nextState?.queuedAtMs;
          const runningAtMs = nextState?.runningAtMs;
          if (
            activationPersisted &&
            !cleanupFailed &&
            queuedAtMs === undefined &&
            runningAtMs === undefined
          ) {
            cleanupFailed = true;
            throw new Error("cleanup persist failed");
          }
          await realSave(storePath, nextStore, opts);
          if (!reservationPersisted && queuedAtMs === dueAt) {
            reservationPersisted = true;
            now = dueAt + 1;
          } else if (reservationPersisted && runningAtMs === dueAt + 1) {
            activationPersisted = true;
            stop(state);
          }
        });

      try {
        const operation =
          trigger === "manual"
            ? run(state, job.id, "force")
            : trigger === "scheduled"
              ? onTimer(state)
              : runMissedJobs(state);
        await expect(operation).rejects.toThrow("cleanup persist failed");
      } finally {
        saveSpy.mockRestore();
      }

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastError).toBe("prior failure");
    },
  );

  it.each(["manual", "scheduled", "startup"] as const)(
    "releases a %s process claim after terminal cleanup failures",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.875Z");
      const job = createDueIsolatedJob({
        id: `terminal-${trigger}-cleanup-failure`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const realSave = cronStoreModule.saveCronJobsStore;
      let reservationPersisted = false;
      let activationPersisted = false;
      const saveSpy = vi
        .spyOn(cronStoreModule, "saveCronJobsStore")
        .mockImplementation(async (storePath, nextStore, opts) => {
          const nextState = nextStore.jobs.find((entry) => entry.id === job.id)?.state;
          const queuedAtMs = nextState?.queuedAtMs;
          const runningAtMs = nextState?.runningAtMs;
          if (activationPersisted && queuedAtMs === undefined && runningAtMs === undefined) {
            throw new Error("terminal cleanup persist failed");
          }
          await realSave(storePath, nextStore, opts);
          if (!reservationPersisted && queuedAtMs === dueAt) {
            reservationPersisted = true;
            now = dueAt + 1;
          } else if (reservationPersisted && runningAtMs === dueAt + 1) {
            activationPersisted = true;
            stop(state);
          }
        });

      try {
        const operation =
          trigger === "manual"
            ? run(state, job.id, "force")
            : trigger === "scheduled"
              ? onTimer(state)
              : runMissedJobs(state);
        await expect(operation).rejects.toThrow("terminal cleanup persist failed");
      } finally {
        saveSpy.mockRestore();
      }

      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
          .runningAtMs,
      ).toBe(dueAt + 1);
    },
  );
});
