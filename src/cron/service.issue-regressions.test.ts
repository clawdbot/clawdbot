import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  noopLogger,
  setupCronIssueRegressionFixtures,
  startCronForStore,
  topOfHourOffsetMs,
  writeCronStoreSnapshot,
} from "./service.issue-regressions.test-helpers.js";
import { CronService } from "./service.js";
import { loadCronStore } from "./store.js";
import type { CronJob, CronJobState } from "./types.js";

describe("Cron issue regressions", () => {
  const cronIssueRegressionFixtures = setupCronIssueRegressionFixtures();

  it("covers schedule updates and payload patching", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
    });

    const created = await cron.add({
      name: "hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    const offsetMs = topOfHourOffsetMs(created.id);
    expect(created.state.nextRunAtMs).toBe(Date.parse("2026-02-06T11:00:00.000Z") + offsetMs);

    const updated = await cron.update(created.id, {
      schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
    });

    expect(updated.state.nextRunAtMs).toBe(Date.parse("2026-02-06T12:00:00.000Z") + offsetMs);

    const unsafeToggle = await cron.add({
      name: "unsafe toggle",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hi" },
    });

    const patched = await cron.update(unsafeToggle.id, {
      payload: { kind: "agentTurn", allowUnsafeExternalContent: true },
    });

    expect(patched.payload.kind).toBe("agentTurn");
    if (patched.payload.kind === "agentTurn") {
      expect(patched.payload.allowUnsafeExternalContent).toBe(true);
      expect(patched.payload.message).toBe("hi");
    }

    cron.stop();
  });

  it("repairs isolated every jobs missing createdAtMs and sets nextWakeAtMs", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "legacy-isolated",
        agentId: "feature-dev_planner",
        sessionKey: "agent:main:main",
        name: "legacy isolated",
        enabled: true,
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "poll workflow queue" },
        state: {},
      },
    ]);

    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await cron.start();

    const status = await cron.status();
    const jobs = await cron.list({ includeDisabled: true });
    const isolated = jobs.find((job) => job.id === "legacy-isolated");
    expect(Number.isFinite(isolated?.state.nextRunAtMs)).toBe(true);
    expect(Number.isFinite(status.nextWakeAtMs)).toBe(true);

    const persisted = await loadCronStore(store.storePath);
    const persistedIsolated = persisted.jobs.find((job) => job.id === "legacy-isolated");
    expect(typeof persistedIsolated?.state?.nextRunAtMs).toBe("number");
    expect(Number.isFinite(persistedIsolated?.state?.nextRunAtMs)).toBe(true);

    cron.stop();
  });

  it("does not rewrite unchanged stores during startup", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T11:00:00.000Z");
    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "startup-stable",
        name: "startup stable",
        createdAtMs: scheduledAt - 60_000,
        updatedAtMs: scheduledAt - 60_000,
        enabled: true,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "stable" },
        state: { nextRunAtMs: scheduledAt },
      },
    ]);
    const before = await fs.readFile(store.storePath, "utf8");

    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: true,
    });
    const after = await fs.readFile(store.storePath, "utf8");

    expect(after).toBe(before);
    cron.stop();
  });

  it("repairs missing nextRunAtMs on non-schedule updates without touching other jobs", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

    const created = await cron.add({
      name: "repair-target",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    const updated = await cron.update(created.id, {
      payload: { kind: "systemEvent", text: "tick-2" },
      state: { nextRunAtMs: undefined },
    });

    expect(updated.payload.kind).toBe("systemEvent");
    expect(typeof updated.state.nextRunAtMs).toBe("number");
    expect(updated.state.nextRunAtMs).toBe(created.state.nextRunAtMs);

    cron.stop();
  });

  it("does not advance unrelated due jobs when updating another job", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    vi.setSystemTime(now);
    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

    const dueJob = await cron.add({
      name: "due-preserved",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "due-preserved" },
    });
    const otherJob = await cron.add({
      name: "other-job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "other" },
    });

    const originalDueNextRunAtMs = dueJob.state.nextRunAtMs;
    expect(typeof originalDueNextRunAtMs).toBe("number");

    vi.setSystemTime(now + 5 * 60_000);

    await cron.update(otherJob.id, {
      payload: { kind: "systemEvent", text: "other-updated" },
    });

    const storeData = await loadCronStore(store.storePath);
    const persistedDueJob = storeData.jobs.find((job) => job.id === dueJob.id);
    expect(persistedDueJob?.state?.nextRunAtMs).toBe(originalDueNextRunAtMs);

    cron.stop();
  });

  it("treats persisted jobs with missing enabled as enabled during update()", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "missing-enabled-update",
        name: "legacy missing enabled",
        createdAtMs: now - 60_000,
        updatedAtMs: now - 60_000,
        schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "legacy" },
        state: {},
      },
    ]);

    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

    const listed = await cron.list();
    const listedJobIds = listed.map((job) => job.id);
    expect(listedJobIds).toContain("missing-enabled-update");

    const updated = await cron.update("missing-enabled-update", {
      schedule: { kind: "cron", expr: "0 */3 * * *", tz: "UTC" },
    });

    expect(updated.state.nextRunAtMs).toBeTypeOf("number");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);

    cron.stop();
  });

  it("treats persisted due jobs with missing enabled as runnable", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const dueAt = now - 30_000;
    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "missing-enabled-due",
        name: "legacy due job",
        createdAtMs: dueAt - 60_000,
        updatedAtMs: dueAt,
        schedule: { kind: "at", at: new Date(dueAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "missing-enabled-due" },
        state: { nextRunAtMs: dueAt },
      },
    ]);

    const enqueueSystemEvent = vi.fn();
    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
      enqueueSystemEvent,
    });

    const result = await cron.run("missing-enabled-due", "due");
    expect(result).toEqual({ ok: true, ran: true });
    const enqueueCall = enqueueSystemEvent.mock.calls.at(0);
    if (!enqueueCall) {
      throw new Error("Expected due cron job to enqueue a system event");
    }
    expect(enqueueCall[0]).toBe("missing-enabled-due");
    expect(enqueueCall[1]?.agentId).toBeUndefined();

    cron.stop();
  });

  it("rejects invalid cron schedule updates without mutating disabled jobs", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

    const disabledJob = await cron.add({
      name: "disabled-cron",
      enabled: false,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });

    await expect(
      cron.update(disabledJob.id, {
        schedule: { kind: "cron", expr: "* * * 13 *", tz: "UTC" },
      }),
    ).rejects.toThrow("CronPattern");

    let persisted = await loadCronStore(store.storePath);
    let storedJob = persisted.jobs.find((job) => job.id === disabledJob.id);
    expect(storedJob?.enabled).toBe(false);
    expect(storedJob?.schedule.kind).toBe("cron");
    if (storedJob?.schedule.kind !== "cron") {
      throw new Error("expected stored cron schedule");
    }
    expect(storedJob.schedule.expr).toBe("0 * * * *");
    expect(storedJob.schedule.tz).toBe("UTC");

    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "invalid-disabled-job",
        name: "invalid disabled job",
        createdAtMs: Date.parse("2026-02-06T10:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-06T10:00:00.000Z"),
        enabled: false,
        schedule: { kind: "cron", expr: "* * * 13 *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
    ]);

    const invalidCron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });
    await expect(invalidCron.update("invalid-disabled-job", { enabled: true })).rejects.toThrow(
      "CronPattern",
    );

    persisted = await loadCronStore(store.storePath);
    storedJob = persisted.jobs.find((job) => job.id === "invalid-disabled-job");
    expect(storedJob?.enabled).toBe(false);
    expect(storedJob?.state.nextRunAtMs).toBeUndefined();

    invalidCron.stop();
    cron.stop();
  });

  it("keeps telegram delivery target writeback after manual cron.run", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const originalTarget = "https://t.me/obviyus";
    const rewrittenTarget = "-10012345/6789";
    const runIsolatedAgentJob = vi.fn(async (params: { job: { id: string } }) => {
      const raw = await fs.readFile(store.storePath, "utf-8");
      const persisted = JSON.parse(raw) as { version: number; jobs: CronJob[] };
      const targetJob = persisted.jobs.find((job) => job.id === params.job.id);
      if (targetJob?.delivery?.channel === "telegram") {
        targetJob.delivery.to = rewrittenTarget;
      }
      await fs.writeFile(store.storePath, JSON.stringify(persisted), "utf-8");
      return { status: "ok" as const, summary: "done", delivered: true };
    });

    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
      runIsolatedAgentJob,
    });
    const job = await cron.add({
      name: "manual-writeback",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: originalTarget,
      },
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: true });

    const persisted = await loadCronStore(store.storePath);
    const persistedJob = persisted.jobs.find((entry) => entry.id === job.id);
    expect(persistedJob?.delivery?.to).toBe(rewrittenTarget);
    expect(persistedJob?.state.lastStatus).toBe("ok");
    expect(persistedJob?.state.lastDelivered).toBe(true);

    cron.stop();
  });

  it("#13845: one-shot jobs with terminal statuses do not re-fire on restart", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const pastAt = Date.parse("2026-02-06T09:00:00.000Z");
    const baseJob = {
      name: "reminder",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: pastAt - 60_000,
      updatedAtMs: pastAt,
      schedule: { kind: "at", at: new Date(pastAt).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "⏰ Reminder" },
    } as const;
    const terminalStates: Array<{ id: string; state: CronJobState }> = [
      {
        id: "oneshot-skipped",
        state: {
          nextRunAtMs: pastAt,
          lastStatus: "skipped",
          lastRunAtMs: pastAt,
        },
      },
      {
        id: "oneshot-errored",
        state: {
          nextRunAtMs: pastAt,
          lastStatus: "error",
          lastRunAtMs: pastAt,
          lastError: "heartbeat failed",
        },
      },
    ];
    for (const { id, state } of terminalStates) {
      const job: CronJob = { id, ...baseJob, state };
      await fs.writeFile(store.storePath, JSON.stringify({ version: 1, jobs: [job] }), "utf-8");
      const enqueueSystemEvent = vi.fn();
      const cron = await startCronForStore({
        storePath: store.storePath,
        enqueueSystemEvent,
        runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
      });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      cron.stop();
    }
  });
});
