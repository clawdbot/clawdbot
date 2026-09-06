import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { beginAgentDeletion, isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { applyClawAddPlan } from "../claws/add.js";
import type { ClawRemoveApplyOptions } from "../claws/lifecycle-remove-contract.js";
import {
  applyClawRemovePlan,
  buildClawRemovePlan,
  readClawStatus,
} from "../claws/lifecycle-state.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  clawMonitorInventorySchema,
  type ClawMonitorCleanupGateway,
} from "../claws/monitor-cleanup-contract.js";
import { parseClawManifest } from "../claws/schema.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyHeartbeatMonitorJobs } from "../cron/heartbeat-monitor.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { CronService } from "../cron/service.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import * as sessionReaper from "../cron/session-reaper.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import {
  claimCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../cron/store/run-receipt-store.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeOperatorScopesForMethod, isGatewayMethodClassified } from "./method-scopes.js";
import { reconcileSkillCollectionReviewJobs } from "./server-cron-skill-review-jobs.js";
import { clawsMonitorHandlers } from "./server-methods/claws-monitors.js";
import type { RespondFn } from "./server-methods/types.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function fixture(
  enabled: boolean,
  runner?: CronServiceDeps["runIsolatedAgentJob"],
  withCron = false,
) {
  const state = await createOpenClawTestState({ label: "claw-monitor-removal" });
  cleanups.push(state.cleanup);
  await fs.writeFile(state.path("SOUL.md"), "synthetic managed file\n");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
    cronJobs: withCron
      ? [
          {
            id: "daily",
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            message: "synthetic daily task",
          },
        ]
      : [],
  });
  if (!parsed.ok) {
    throw new Error("Invalid synthetic Claw fixture.");
  }
  const workspaceDir = state.path("claw-workspace");
  const addPlan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source: {
      kind: "package",
      name: "synthetic-worker",
      version: "1.0.0",
      packageRoot: state.root,
      manifestPath: state.path("openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:synthetic",
      byteLength: 100,
    },
    context: { workspace: workspaceDir },
  });
  expect(addPlan.blockers).toEqual([]);
  let config: OpenClawConfig = {
    agents: { defaults: { heartbeat: { every: enabled ? "30m" : "0m" } } },
    skills: { workshop: { autonomous: { mode: enabled ? "auto" : "off" } } },
  };
  const storePath = state.statePath("cron", "jobs.json");
  const cronDeps: CronServiceDeps = {
    storePath,
    cronEnabled: false,
    log: logger,
    defaultAgentId: "worker",
    resolveSessionStorePath: (agentId = "worker") =>
      state.statePath("agents", agentId, "sessions", "sessions.json"),
    resolveDefaultAgentId: () => listAgentEntries(config)[0]?.id ?? "main",
    isAgentAvailable: (agentId) =>
      !isAgentDeletionBlocked(agentId) &&
      listAgentEntries(config).some((agent) => agent.id === agentId),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: runner ?? vi.fn(async () => ({ status: "ok" as const })),
  };
  const cron = new CronService(cronDeps);
  cleanups.push(async () => {
    cron.stop();
  });
  await applyClawAddPlan(addPlan, {
    consentPlanIntegrity: addPlan.planIntegrity,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    cronGateway: {
      add: async (input) => {
        const normalized = normalizeCronJobCreate(input);
        if (!normalized) {
          throw new Error("Invalid synthetic cron input");
        }
        return { id: (await cron.add(normalized)).id };
      },
    },
  });
  const reconcile = async () => {
    expect((await applyHeartbeatMonitorJobs({ cron, cfg: config })).ok).toBe(true);
    expect(
      (await reconcileSkillCollectionReviewJobs({ cron, cfg: config, logger })).ok,
      JSON.stringify(logger.warn.mock.calls.slice(-3)),
    ).toBe(true);
  };
  await reconcile();
  let reloadSettled = true;
  const context = {
    cron,
    cronStorePath: storePath,
    getRuntimeConfig: () => config,
    isConfigReloadSettled: () => reloadSettled,
  };
  const invoke = async (params: Record<string, unknown>) => {
    let response: unknown;
    let failure: string | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      if (ok) {
        response = payload;
      } else {
        failure = error?.message ?? "Gateway refusal";
      }
    };
    await clawsMonitorHandlers["claws.monitors"]({
      params: { binding: resolveClawMonitorCleanupBinding(storePath), ...params },
      context,
      respond,
    });
    if (failure) {
      throw new Error(failure);
    }
    return response;
  };
  const gateway: ClawMonitorCleanupGateway = {
    inspect: async (agentId) =>
      clawMonitorInventorySchema.parse(await invoke({ phase: "inspect", agentId })).monitors,
    quiesce: async (agentId, operationId, monitors) => {
      await invoke({ phase: "quiesce", agentId, operationId, monitors });
    },
    drain: async (agentId, operationId) => {
      await invoke({ phase: "drain", agentId, operationId });
    },
  };
  const commitConfig = async (transform: (cfg: OpenClawConfig) => OpenClawConfig) => {
    config = transform(config);
    await reconcile();
  };
  const plan = () => buildClawRemovePlan("worker", { config, monitorGateway: gateway });
  const apply = async (
    removal: Awaited<ReturnType<typeof plan>>,
    overrides: Partial<ClawRemoveApplyOptions> = {},
  ) =>
    applyClawRemovePlan(removal, {
      config,
      monitorGateway: gateway,
      cronGateway: {
        get: async (id) => {
          const job = await cron.readJob(id);
          return job ? cronJobReadView(job) : null;
        },
        remove: async (id) => await cron.remove(id),
      },
      commitConfig,
      consentPlanIntegrity: removal.planIntegrity,
      ...overrides,
    });
  return {
    state,
    workspaceDir,
    cron,
    gateway,
    plan,
    apply,
    invoke,
    commitConfig,
    reconcile,
    replaceCron: () => {
      const replacement = new CronService(cronDeps);
      context.cron = replacement;
      cleanups.push(async () => {
        replacement.stop();
      });
    },
    getConfig: () => config,
    setReloadSettled: (value: boolean) => {
      reloadSettled = value;
    },
  };
}

describe("Claw serving monitor cleanup", () => {
  it.each(["quiesce", "drain"])(
    "retains a configured agent without a Claw install during %s",
    async (phase) => {
      const current = await fixture(false);
      const deletion = beginAgentDeletion({
        agentId: "worker",
        agentDir: current.state.agentDir("worker"),
        workspaceDir: current.workspaceDir,
        sessionsDir: current.state.sessionsDir("worker"),
        deleteFiles: false,
      });
      openOpenClawStateDatabase()
        .db.prepare("DELETE FROM claw_installs WHERE agent_id = ?")
        .run("worker");
      await expect(
        current.invoke({
          phase,
          agentId: "worker",
          operationId: deletion.entry.operationId,
          ...(phase === "quiesce" ? { monitors: await current.gateway.inspect("worker") } : {}),
        }),
      ).rejects.toThrow("configuration changed");
      expect(listAgentEntries(current.getConfig()).some((agent) => agent.id === "worker")).toBe(
        true,
      );
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
    },
  );

  it("removes orphaned workspace ownership through the serving monitor handler", async () => {
    const current = await fixture(false);
    await current.commitConfig(() => ({
      agents: { entries: { main: { workspace: current.state.path("main-workspace") } } },
    }));
    openOpenClawStateDatabase()
      .db.prepare("DELETE FROM claw_installs WHERE agent_id = ?")
      .run("worker");
    expect(
      (await readClawStatus("worker", { config: current.getConfig() })).records[0],
    ).toMatchObject({
      orphaned: true,
      agentState: "missing",
    });
    const plan = await current.plan();
    expect(plan.blockers).toEqual([]);
    expect(await current.apply(plan)).toMatchObject({ status: "complete", agentRemoved: false });
    expect(readAgentDeletionJournal("worker")?.cleanupCompleted).toBe(true);
    expect((await readClawStatus("worker", { config: current.getConfig() })).summary.claws).toBe(0);
    await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).rejects.toThrow();
  });

  it("retains local monitor blockers when the serving inspection is unavailable", async () => {
    const current = await fixture(false);
    const plan = await buildClawRemovePlan("worker", {
      config: current.getConfig(),
      monitorGateway: {
        ...current.gateway,
        inspect: async () => {
          throw new Error("Gateway offline");
        },
      },
    });
    expect(plan.blockers).toHaveLength(2);
    const jobs = plan.actions.filter((action) => action.kind === "scheduledJob");
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job).toMatchObject({
        action: "retain",
        blocked: true,
        details: { monitorInspection: "unavailable" },
      });
    }
    expect(readAgentDeletionJournal("worker")).toBeUndefined();
  });

  it("removes recorded Claw schedules alongside monitors with one disposition each", async () => {
    const current = await fixture(false, undefined, true);
    const plan = await current.plan();
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.filter((action) => action.kind === "cronJob")).toHaveLength(1);
    expect(plan.actions.filter((action) => action.kind === "scheduledJob")).toHaveLength(2);
    expect(await current.apply(plan)).toMatchObject({
      status: "complete",
      cronJobs: [expect.objectContaining({ manifestId: "daily", action: "removed" })],
    });
  });

  it("requires authenticated administrator scope for the monitor phase method", () => {
    expect(isGatewayMethodClassified("claws.monitors")).toBe(true);
    for (const scopes of [[], ["operator.read"], ["operator.write"]]) {
      expect(authorizeOperatorScopesForMethod("claws.monitors", scopes)).toEqual({
        allowed: false,
        missingScope: "operator.admin",
      });
    }
    expect(authorizeOperatorScopesForMethod("claws.monitors", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

  it.each(["configPath", "statePath", "cronStorePath"])(
    "refuses a different %s binding",
    async (field) => {
      const current = await fixture(false);
      await expect(
        current.invoke({
          phase: "inspect",
          agentId: "worker",
          binding: {
            ...resolveClawMonitorCleanupBinding(current.state.statePath("cron", "jobs.json")),
            [field]: current.state.path("different-owner"),
          },
        }),
      ).rejects.toThrow("does not serve");
      expect(readAgentDeletionJournal("worker")).toBeUndefined();
    },
  );

  it.each(["operation", "scheduler"])(
    "revalidates the %s owner after awaited inventory",
    async (changedOwner) => {
      const current = await fixture(false);
      const database = openOpenClawAgentDatabase({ agentId: "worker" });
      const monitors = await current.gateway.inspect("worker");
      const target = {
        agentId: "worker",
        agentDir: current.state.agentDir("worker"),
        workspaceDir: current.workspaceDir,
        sessionsDir: current.state.sessionsDir("worker"),
        deleteFiles: false,
      };
      const deletion = beginAgentDeletion(target);
      const originalList = current.cron.list.bind(current.cron);
      const list = vi.spyOn(current.cron, "list").mockImplementationOnce(async (opts) => {
        const jobs = await originalList(opts);
        if (changedOwner === "operation") {
          beginAgentDeletion(target);
        } else {
          current.replaceCron();
        }
        return jobs;
      });
      try {
        await expect(
          current.gateway.quiesce("worker", deletion.entry.operationId, monitors),
        ).rejects.toThrow(changedOwner === "operation" ? "deletion fence" : "changing");
        expect(database.db.prepare("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
        await expect(
          fs.access(path.join(current.workspaceDir, "SOUL.md")),
        ).resolves.toBeUndefined();
      } finally {
        list.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "retains files for a foreign receipt after its job row disappears (unverifiable=%s)",
    async (unverifiable) => {
      const current = await fixture(false);
      const monitor = (await current.cron.list({ includeDisabled: true })).find(
        (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
      )!;
      const prepared = prepareCronRunReceiptClaim({
        storePath: current.state.statePath("cron", "jobs.json"),
        job: monitor,
        agentId: "worker",
        startedAtMs: Date.now(),
      });
      const handle = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabase({
          database: db,
          prepared,
          resolveAgentId: () => "worker",
        }),
      );
      const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        env: { PATH: process.env.PATH, HOME: current.state.home },
      });
      try {
        await once(holder, "spawn");
        if (!holder.pid) {
          throw new Error("Missing fixture process identity");
        }
        const ownerStartTime = unverifiable ? null : getFileLockProcessStartTime(holder.pid);
        const database = openOpenClawStateDatabase();
        database.db
          .prepare(
            "UPDATE cron_run_receipts SET owner_pid = ?, owner_start_time = ? WHERE receipt_id = ?",
          )
          .run(holder.pid, ownerStartTime, handle.receiptId);
        if (unverifiable) {
          database.db
            .prepare("UPDATE cron_run_receipts SET started_at_ms = ? WHERE receipt_id = ?")
            .run(Date.now() - 24 * 60 * 60_000, handle.receiptId);
        }
        releaseLocalCronRunReceiptOwnership(handle);
        database.db.prepare("DELETE FROM cron_jobs WHERE job_id = ?").run(monitor.id);
        expect(getSuspensionVisibleCronTaskRunCount({ agentId: "worker" })).toBe(0);
        const result = await current.apply(await current.plan());
        expect(result).toMatchObject({ status: "partial", agentRemoved: false });
        await expect(
          fs.access(path.join(current.workspaceDir, "SOUL.md")),
        ).resolves.toBeUndefined();
        const exit = once(holder, "exit");
        holder.kill("SIGTERM");
        await exit;
        expect(
          database.db
            .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
            .get(handle.receiptId),
        ).toEqual({ status: "running" });
        expect(await current.apply(await current.plan())).toMatchObject({ status: "complete" });
      } finally {
        if (holder.pid && holder.exitCode === null && holder.signalCode === null) {
          const exit = once(holder, "exit");
          holder.kill("SIGTERM");
          await exit;
        }
        releaseLocalCronRunReceiptOwnership(handle);
      }
    },
  );

  it("closes idle databases but waits for an agent still configured through agents.list", async () => {
    const current = await fixture(false);
    const database = openOpenClawAgentDatabase({ agentId: "worker" });
    const monitors = await current.gateway.inspect("worker");
    const deletion = beginAgentDeletion({
      agentId: "worker",
      agentDir: current.state.agentDir("worker"),
      workspaceDir: current.workspaceDir,
      sessionsDir: current.state.sessionsDir("worker"),
      deleteFiles: false,
    });
    await current.gateway.quiesce("worker", deletion.entry.operationId, monitors);
    expect(() => database.db.prepare("SELECT 1")).toThrow();
    const config = current.getConfig();
    config.agents = { ...config.agents, entries: undefined, list: listAgentEntries(config) };
    for (const monitor of monitors) {
      await current.cron.remove(monitor.id, { systemOwned: true });
    }
    expect(
      (await current.cron.list({ includeDisabled: true })).filter(
        (job) => job.agentId === "worker",
      ),
    ).toEqual([]);
    expect(listAgentEntries(current.getConfig()).map((agent) => agent.id)).toContain("worker");
    await expect(current.gateway.drain("worker", deletion.entry.operationId)).rejects.toThrow(
      "config convergence is incomplete",
    );
    await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
    expect(await current.apply(await current.plan())).toMatchObject({ status: "complete" });
  });

  it("waits for deferred session cleanup after the monitor row and runner are gone", async () => {
    const runStarted = createDeferred();
    const releaseRun = createDeferred();
    const current = await fixture(true, async () => {
      runStarted.resolve();
      await releaseRun.promise;
      return { status: "ok" };
    });
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanupFinished = createDeferred();
    let cleaning = false;
    const original = sessionReaper.removeCronJobBaseSession;
    const cleanupSpy = vi
      .spyOn(sessionReaper, "removeCronJobBaseSession")
      .mockImplementation(async (params) => {
        if (params.jobId !== monitor.id) {
          return await original(params);
        }
        cleaning = true;
        cleanupStarted.resolve();
        try {
          await releaseCleanup.promise;
          return await original(params);
        } finally {
          cleanupFinished.resolve();
        }
      });
    const run = current.cron.run(monitor.id, "force");
    try {
      await runStarted.promise;
      await current.cron.remove(monitor.id, { systemOwned: true });
      await run;
      await cleanupStarted.promise;
      releaseRun.resolve();
      await vi.waitFor(() =>
        expect(getSuspensionVisibleCronTaskRunCount({ agentId: "worker" })).toBe(0),
      );
      expect(await current.cron.readJob(monitor.id)).toBeUndefined();
      const result = await current.apply(await current.plan());
      expect(result).toMatchObject({ status: "partial", agentRemoved: false });
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      releaseCleanup.resolve();
      await cleanupFinished.promise;
      expect(await current.apply(await current.plan())).toMatchObject({ status: "complete" });
    } finally {
      releaseRun.resolve();
      releaseCleanup.resolve();
      await run;
      if (cleaning) {
        await cleanupFinished.promise;
      }
      cleanupSpy.mockRestore();
    }
  });

  it.each(["config-write", "cron-persistence", "lost-cancellation-response", "reload"])(
    "retains cleanup state after a %s failure and completes a fresh retry",
    async (failure) => {
      const current = await fixture(false);
      const plan = await current.plan();
      const result = await current.apply(plan, {
        ...(failure === "reload"
          ? {
              commitConfig: async (transform) => {
                await current.commitConfig(transform);
                current.setReloadSettled(false);
              },
            }
          : {}),
        ...(failure === "config-write"
          ? {
              commitConfig: async () => {
                throw new Error("synthetic config persistence failure");
              },
            }
          : {}),
        ...(failure === "cron-persistence"
          ? {
              commitConfig: async (transform) => {
                const database = openOpenClawStateDatabase();
                database.db.exec(`CREATE TEMP TRIGGER refuse_monitor_delete
                  BEFORE DELETE ON cron_jobs WHEN OLD.agent_id = 'worker'
                  BEGIN SELECT RAISE(ABORT, 'synthetic monitor persistence failure'); END`);
                try {
                  await current.commitConfig(transform);
                } finally {
                  database.db.exec("DROP TRIGGER refuse_monitor_delete");
                }
              },
            }
          : {}),
        ...(failure === "lost-cancellation-response"
          ? {
              monitorGateway: {
                ...current.gateway,
                quiesce: async (...args) => {
                  await current.gateway.quiesce(...args);
                  throw new Error("synthetic lost cancellation response");
                },
              },
            }
          : {}),
      });
      expect(result).toMatchObject({
        status: "partial",
        error: { code: "monitor_cleanup_failed" },
      });
      const firstJournal = readAgentDeletionJournal("worker");
      expect(firstJournal).toBeDefined();
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      closeOpenClawStateDatabaseForTest();
      expect(readAgentDeletionJournal("worker")?.operationId).toBe(firstJournal?.operationId);
      current.setReloadSettled(true);
      if (failure === "cron-persistence") {
        expect(
          (await current.cron.list({ includeDisabled: true })).some(
            (job) => job.agentId === "worker",
          ),
        ).toBe(true);
        await current.reconcile();
      }
      const retry = await current.plan();
      expect(await current.apply(retry)).toMatchObject({ status: "complete" });
      await expect(
        current.invoke({
          phase: "drain",
          agentId: "worker",
          operationId: firstJournal!.operationId,
        }),
      ).rejects.toThrow("deletion fence");
    },
  );

  it("rejects source drift after preview before creating a deletion fence", async () => {
    const current = await fixture(false);
    const plan = await current.plan();
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    upsertCronJobRow(
      openOpenClawStateDatabase().db,
      current.state.statePath("cron", "jobs.json"),
      { ...monitor, payload: { kind: "agentTurn", message: "changed source" } },
      0,
    );
    await expect(current.apply(plan)).rejects.toMatchObject({ code: "remove_changed" });
    expect(readAgentDeletionJournal("worker")).toBeUndefined();
    await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
  });

  it("does not cancel or wait for a surviving agent's ordinary runner", async () => {
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const current = await fixture(false, async ({ abortSignal }) => {
      if (!abortSignal) {
        throw new Error("Missing cancellation signal");
      }
      started.resolve(abortSignal);
      await release.promise;
      return { status: "ok" };
    });
    const added = await current.cron.add({
      agentId: "main",
      name: "surviving ordinary job",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "synthetic held run" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
    const run = current.cron.run(added.id, "force");
    const signal = await started.promise;
    try {
      const plan = await current.plan();
      expect(await current.apply(plan)).toMatchObject({ status: "complete" });
      expect(signal.aborted).toBe(false);
      expect(await current.cron.readJob(added.id)).toBeDefined();
    } finally {
      release.resolve();
      await run;
    }
  });

  it.each([false, true])(
    "removes both config-owned monitor families (enabled=%s)",
    async (enabled) => {
      const current = await fixture(enabled);
      const plan = await current.plan();
      expect(plan.blockers).toEqual([]);
      expect(plan.actions.filter((action) => action.kind === "scheduledJob")).toEqual([
        expect.objectContaining({ action: "remove", blocked: false }),
        expect.objectContaining({ action: "remove", blocked: false }),
      ]);
      const result = await current.apply(plan);
      expect(result).toMatchObject({ status: "complete", agentRemoved: true });
      expect(
        (await current.cron.list({ includeDisabled: true })).every(
          (job) => job.agentId !== "worker",
        ),
      ).toBe(true);
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).rejects.toThrow();
    },
  );

  it.each([
    "ordinary",
    "imported",
    "foreign-store",
    "reassigned",
    "changed-payload",
    "changed-name",
    "changed-wake",
    "changed-delivery",
  ])("keeps %s scheduled work outside monitor cleanup", async (variant) => {
    const current = await fixture(false);
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    const changed = {
      ...monitor,
      id: variant.startsWith("changed-") ? monitor.id : "independent",
      ...(variant === "ordinary" ? { declarationKey: "operator-job" } : {}),
      ...(variant === "changed-name" ? { name: "operator name" } : {}),
      ...(variant === "changed-wake" ? { wakeMode: "now" as const } : {}),
      ...(variant === "changed-delivery" ? { delivery: { mode: "announce" as const } } : {}),
      ...(variant === "imported" ? { declarationKey: "heartbeat-task:worker:imported" } : {}),
      ...(variant === "reassigned" ? { agentId: "other", owner: { agentId: "worker" } } : {}),
      ...(variant === "changed-payload"
        ? { payload: { kind: "agentTurn" as const, message: "independent" } }
        : {}),
    };
    const database = openOpenClawStateDatabase();
    upsertCronJobRow(
      database.db,
      variant === "foreign-store" ? "/foreign/cron" : current.state.statePath("cron", "jobs.json"),
      changed,
      10,
    );
    const plan = await current.plan();
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_job_attached" }));
    await expect(current.apply(plan)).rejects.toMatchObject({ code: "remove_blocked" });
    await expect(fs.readFile(path.join(current.workspaceDir, "SOUL.md"), "utf8")).resolves.toBe(
      "synthetic managed file\n",
    );
  });

  it("keeps files and a durable retry fence while a cancelled runner core is held", async () => {
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const current = await fixture(true, async ({ abortSignal }) => {
      if (!abortSignal) {
        throw new Error("Missing cancellation signal");
      }
      started.resolve(abortSignal);
      await release.promise;
      return { status: "ok" };
    });
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    const run = current.cron.run(monitor.id, "force");
    const signal = await started.promise;
    try {
      const plan = await current.plan();
      const removal = current.apply(plan);
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      await run;
      const result = await removal;
      expect(result).toMatchObject({
        status: "partial",
        agentRemoved: false,
        error: { code: "monitor_cleanup_failed" },
      });
      expect(readAgentDeletionJournal("worker")).toBeDefined();
      expect(Object.hasOwn(current.getConfig().agents?.entries ?? {}, "worker")).toBe(true);
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      closeOpenClawStateDatabaseForTest();
      expect(readAgentDeletionJournal("worker")).toBeDefined();
      release.resolve();
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      const retry = await current.plan();
      expect(await current.apply(retry)).toMatchObject({ status: "complete" });
    } finally {
      release.resolve();
      await run;
    }
  });
});
