// Cron service timer tests cover timer scheduling, cancellation, and wakeups.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as jobPrecheck from "../../cron/job-precheck.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { formatTaskStatusDetail } from "../../tasks/task-status.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { getSuspensionVisibleCronTaskRunCount } from "./active-run-cancellation.js";
import { stop } from "./ops-lifecycle.js";
import { executeJobCore } from "./timer-execution.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});

function createCronServiceState(
  params: Parameters<typeof createCronServiceStateBase>[0],
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({ defaultAgentId: "main", ...params });
}

function createDueMainJob(params: { now: number; wakeMode: CronJob["wakeMode"] }): CronJob {
  return {
    id: "main-heartbeat-job",
    name: "main heartbeat job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "main",
    wakeMode: params.wakeMode,
    payload: { kind: "systemEvent", text: "heartbeat seam tick" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueIsolatedAgentJob(params: { now: number }): CronJob {
  return {
    id: "isolated-agent-job",
    agentId: "finn",
    name: "isolated agent job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run isolated cron" },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueCommandJob(params: { now: number }): CronJob {
  return {
    id: "command-job",
    agentId: "finn",
    name: "command job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueScriptJob(params: {
  now: number;
  sessionTarget?: "main" | "isolated";
  pacing?: CronJob["pacing"];
}): CronJob {
  return {
    id: "script-job",
    agentId: "finn",
    name: "script job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    pacing: params.pacing,
    sessionTarget: params.sessionTarget ?? "isolated",
    wakeMode: "now",
    payload: {
      kind: "script",
      script: "return { notify: 'done' }",
      timeoutSeconds: 300,
      toolBudget: 50,
    },
    state: { nextRunAtMs: params.now - 1, triggerState: { revision: 1 } },
  };
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return (
    findTaskByRunId(baseRunId) ??
    listTaskRecordsUnsorted().find((task) => task.runId?.startsWith(`${baseRunId}:`))
  );
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer seam coverage", () => {
  it("routes main cron jobs to the owning agent's main session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const requestHeartbeatAndWait = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const job = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      sessionKey: "agent:main-pr-router:main",
      state: { runningAtMs: now },
    };
    const sessionStorePath = path.join(path.dirname(path.dirname(storePath)), "sessions.json");
    await upsertSessionEntryCore(
      { storePath: sessionStorePath, sessionKey: "agent:main-pr-router:main" },
      {
        sessionId: "main-pr-router-session",
        updatedAt: now,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", to: "channel-1", accountId: "default" },
        }),
      },
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      defaultAgentId: "main-pr-router",
      resolveSessionStorePath: () => sessionStorePath,
      enqueueSystemEvent,
      requestHeartbeat,
      requestHeartbeatAndWait,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({ status: "ok" });
    expect(result.sessionKey).toBeUndefined();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "main-pr-router",
      contextKey: "cron:main-heartbeat-job",
      deliveryContext: { channel: "discord", to: "channel-1", accountId: "default" },
    });
    expect(requestHeartbeatAndWait).toHaveBeenCalledWith(
      {
        source: "cron",
        intent: "immediate",
        reason: "cron:main-heartbeat-job",
        agentId: "main-pr-router",
        heartbeat: { target: "last" },
      },
      expect.objectContaining({ stopWaitingOnRetry: expect.any(Function) }),
    );
  });

  it("persists the next schedule and hands off next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const jobWithoutExplicitOwner = createDueMainJob({ now, wakeMode: "next-heartbeat" });
    delete jobWithoutExplicitOwner.sessionKey;
    await writeCronStoreSnapshot({ storePath, jobs: [jobWithoutExplicitOwner] });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      defaultAgentId: "stale-default",
      resolveDefaultAgentId: () => "ops",
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "ops",
      contextKey: "cron:main-heartbeat-job",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "cron",
      intent: "event",
      reason: "cron:main-heartbeat-job",
      agentId: "ops",
      heartbeat: { target: "last" },
    });

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted heartbeat cron job");
    }
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(now + 60_000);
    const task = findCronTaskByBaseRunId(`cron:main-heartbeat-job:${now}`);
    if (!task) {
      throw new Error("expected cron task ledger record");
    }
    expect(task.runtime).toBe("cron");
    expect(task.sourceId).toBe("main-heartbeat-job");
    expect(task.agentId).toBe("ops");
    expect(task.ownerKey).toBe("");
    expect(task.scopeKind).toBe("system");
    expect(task.childSessionKey).toBeUndefined();
    expect(task.runId).toMatch(new RegExp(`^cron:main-heartbeat-job:${now}:`));
    expect(task.label).toBe("main heartbeat job");
    expect(task.task).toBe("main heartbeat job");
    expect(task.status).toBe("succeeded");
    expect(task.deliveryStatus).toBe("not_applicable");
    expect(task.notifyPolicy).toBe("silent");
    expect(task.startedAt).toBe(now);
    expect(task.lastEventAt).toBe(now);
    expect(task.endedAt).toBe(now);
    expect(task.cleanupAfter).toBe(now + 7 * 24 * 60 * 60_000);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    const positiveDelays = delays.filter((delay) => delay > 0);
    expect(positiveDelays.length).toBeGreaterThan(0);

    timeoutSpy.mockRestore();
  });

  it("uses the persisted execution timestamp for the canonical timer task", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    let clock = now;
    let persistedReservation: number | undefined;
    let liveReservation: number | undefined;
    let liveError: string | undefined;
    let emittedStartedAt: number | undefined;
    let reservedAt: number | undefined;
    const job = createDueIsolatedAgentJob({ now });
    job.state.lastError = "previous failure";
    await writeCronStoreSnapshot({
      storePath,
      jobs: [job],
    });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => clock++,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        persistedReservation = (await loadCronStore(storePath)).jobs[0]?.state.runningAtMs;
        liveReservation = state.store?.jobs[0]?.state.runningAtMs;
        liveError = state.store?.jobs[0]?.state.lastError;
        return { status: "ok" as const, delivered: true };
      }),
      onEvent: (event) => {
        if (event.action === "started") {
          emittedStartedAt = event.runAtMs;
        }
      },
    });
    const database = openOpenClawStateDatabase().db;
    database.function("observe_timer_reservation", (stateJson) => {
      if (typeof stateJson === "string") {
        const marker = (JSON.parse(stateJson) as CronJob["state"]).queuedAtMs;
        if (reservedAt === undefined && typeof marker === "number") {
          reservedAt = marker;
        }
      }
      return 0;
    });
    database.exec(`
      CREATE TEMP TRIGGER observe_timer_reservation
      AFTER UPDATE ON cron_jobs
      WHEN NEW.job_id = '${job.id}'
      BEGIN
        SELECT observe_timer_reservation(NEW.state_json);
      END;
    `);

    try {
      await onTimer(state);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS observe_timer_reservation");
    }

    expect(reservedAt).toEqual(expect.any(Number));
    expect(persistedReservation).toEqual(expect.any(Number));
    expect(reservedAt).not.toBe(persistedReservation);
    expect(liveReservation).toBe(persistedReservation);
    expect(liveError).toBeUndefined();
    expect(emittedStartedAt).toBe(persistedReservation);
    expect(
      findCronTaskByBaseRunId(`cron:isolated-agent-job:${persistedReservation}`),
    ).toMatchObject({
      startedAt: emittedStartedAt,
      status: "succeeded",
    });
  });

  it.each(["command", "script", "systemEvent", "heartbeat"] as const)(
    "does not run a %s payload when trigger evaluation resolves after cancellation",
    async (kind) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-07-27T12:00:00.000Z");
      const evaluation = createDeferred<{
        kind: "evaluated";
        fire: true;
        state: { revision: number };
      }>();
      const evaluateCronTrigger = vi.fn(() => evaluation.promise);
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const runCommandJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
      const runScriptJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
      const runIsolatedAgentJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat,
        evaluateCronTrigger,
        runCommandJob,
        runScriptJob,
        runIsolatedAgentJob,
      });
      const baseJob =
        kind === "command"
          ? createDueCommandJob({ now })
          : kind === "script"
            ? createDueScriptJob({ now })
            : kind === "heartbeat"
              ? {
                  ...createDueMainJob({ now, wakeMode: "next-heartbeat" }),
                  payload: { kind },
                }
              : createDueMainJob({ now, wakeMode: "next-heartbeat" });
      const job: CronJob = {
        ...baseJob,
        trigger: { script: "json({ fire: true })" },
      };
      const controller = new AbortController();

      const result = executeJobCore(state, job, controller.signal);
      try {
        expect(evaluateCronTrigger).toHaveBeenCalledOnce();
        controller.abort(new Error("operator cancelled the scheduled run"));
        evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });

        await expect(result).resolves.toMatchObject({ status: "error" });
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
        expect(runCommandJob).not.toHaveBeenCalled();
        expect(runScriptJob).not.toHaveBeenCalled();
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      } finally {
        // Abort before releasing evaluation so failed assertions cannot start payload work.
        controller.abort(new Error("operator cancelled the scheduled run"));
        evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });
        await result;
      }
    },
  );

  it("runs command cron jobs without isolated agent setup", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const runCommandJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "command ok",
    }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      runCommandJob,
    });
    const job = createDueCommandJob({ now });

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({ status: "ok", summary: "command ok" });
    expect(runCommandJob).toHaveBeenCalledWith({
      job,
      abortSignal: undefined,
    });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("records an execution error when script payloads are disabled", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob,
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("the operator set cron.triggers.enabled: false"),
    });
    expect(runScriptJob).not.toHaveBeenCalled();
  });

  it("blocks a host-shell precheck when cron.triggers.enabled is false", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      // triggers disabled: unattended host-shell execution must be denied.
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    const job: CronJob = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      precheck: { kind: "exec", command: "exit 2" },
    };

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("cron.triggers.enabled=true"),
    });
    // The gate must short-circuit before any agent payload runs.
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("allows a host-shell precheck to skip the payload when triggers are enabled", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    // This path needs triggers + a permitting exec security (host approvals often
    // default allowlist/full). Policy denies without shell spawn are covered in
    // job-precheck.test.ts. Here we prove no-work precheck skips the payload.
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      // exit code 2 = NO_WORK under the default exit-code contract.
      precheck: { kind: "exec", command: "exit 2" },
    };

    const result = await executeJobCore(state, job);
    const agent = state.deps.runIsolatedAgentJob as ReturnType<typeof vi.fn>;

    // Host exec policy may deny without spawning; either path must not run payload/agent.
    if (result.status === "error") {
      expect(String(result.error)).toContain("precheck-policy-denied");
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({
      status: "skipped",
      error: "precheck-no-work",
      summary: "precheck-no-work",
    });
    // No payload/model side effect on a no-work skip.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });

  it("persists precheck-skipped-error through onTimer when onError=skip (distinct from no-work)", async () => {
    // ClawSweeper P2: failed probes with onError=skip must not look like quiet no-work.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-15T07:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const spy = vi.spyOn(jobPrecheck, "runCronJobPrecheck").mockResolvedValue({
      decision: "skip",
      reason: "precheck-skipped-error",
      exitCode: 7,
      stdout: "",
      stderr: "boom",
    } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>);
    try {
      const job: CronJob = {
        ...createDueIsolatedAgentJob({ now }),
        id: "precheck-skipped-error-persist",
        precheck: { kind: "exec", command: "exit 7", onError: "skip" },
      };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);

      const stored = await loadCronStore(storePath);
      const persisted = stored.jobs.find((entry) => entry.id === "precheck-skipped-error-persist");
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(persisted?.state.lastStatus).toBe("skipped");
      expect(persisted?.state.lastError ?? "").toContain("precheck-skipped-error");
      expect(persisted?.state.lastError ?? "").not.toContain("precheck-no-work");
    } finally {
      spy.mockRestore();
    }
  });

  it("persists precheck-no-work through onTimer without an agent turn", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const job: CronJob = {
      ...createDueIsolatedAgentJob({ now }),
      id: "precheck-no-work-persist",
      precheck: { kind: "exec", command: "exit 2" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    const persisted = stored.jobs.find((entry) => entry.id === "precheck-no-work-persist");
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    // Policy-deny vs no-work both prove zero agent turns; prefer no-work when allowed.
    if (persisted?.state.lastStatus === "error") {
      expect(persisted.state.lastError ?? "").toContain("precheck-policy-denied");
      return;
    }
    expect(persisted?.state.lastStatus).toBe("skipped");
    expect(persisted?.state.lastError ?? "").toContain("precheck-no-work");
    expect(persisted?.state.consecutiveSkipped ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("runs host-shell precheck when cron.triggers is omitted (documented default-on)", async () => {
    // ClawSweeper P1: validation/docs default triggers on; runtime must use !== false.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-17T18:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const spy = vi
      .spyOn(jobPrecheck, "runCronJobPrecheck")
      .mockImplementation(async (_spec, opts) => {
        expect(opts?.authz?.triggersEnabled).toBe(true);
        return {
          decision: "skip",
          reason: "precheck-no-work",
          exitCode: 2,
          stdout: "",
          stderr: "",
        } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>;
      });
    try {
      const job: CronJob = {
        ...createDueIsolatedAgentJob({ now }),
        id: "precheck-default-triggers-omitted",
        precheck: { kind: "exec", command: "exit 2" },
      };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        // Omit cron.triggers entirely — must not policy-deny.
        cronConfig: {},
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);

      const stored = await loadCronStore(storePath);
      const persisted = stored.jobs.find(
        (entry) => entry.id === "precheck-default-triggers-omitted",
      );
      expect(spy).toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(persisted?.state.lastStatus).toBe("skipped");
      expect(persisted?.state.lastError ?? "").toContain("precheck-no-work");
    } finally {
      spy.mockRestore();
    }
  });

  it("binds precheck authz to effective default agent for agent-less jobs", async () => {
    // ClawSweeper P1: agent-less jobs must pass effective owner (defaultAgentId)
    // into precheck authz, not bare job.agentId (generic default approvals).
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-17T18:30:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const spy = vi
      .spyOn(jobPrecheck, "runCronJobPrecheck")
      .mockImplementation(async (_spec, opts) => {
        expect(opts?.authz?.agentId).toBe("main");
        return {
          decision: "skip",
          reason: "precheck-no-work",
          exitCode: 2,
          stdout: "",
          stderr: "",
        } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>;
      });
    try {
      const job: CronJob = {
        ...createDueIsolatedAgentJob({ now }),
        id: "precheck-effective-agent",
        agentId: undefined,
        precheck: { kind: "exec", command: "exit 2" },
      };
      // Drop agentId from the job record for agent-less path.
      delete (job as { agentId?: string }).agentId;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);

      expect(spy).toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("persists precheck-policy-denied through onTimer without an agent turn", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:30:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const job: CronJob = {
      ...createDueIsolatedAgentJob({ now }),
      id: "precheck-denied-persist",
      precheck: { kind: "exec", command: "exit 0" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      // triggers off => shared host-shell admission denies before spawn
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    const persisted = stored.jobs.find((entry) => entry.id === "precheck-denied-persist");
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(persisted?.state.lastStatus).toBe("error");
    expect(persisted?.state.lastError ?? "").toMatch(
      /precheck-policy-denied|cron\.triggers\.enabled=true/,
    );
  });

  it.each([
    ["now", "immediate"],
    ["next-heartbeat", "event"],
  ] as const)("turns a main script notify and %s wake into one event", async (wake, intent) => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const job = createDueScriptJob({ now, sessionTarget: "main" });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        notify: "queue changed",
        wake,
      })),
    });

    await expect(executeJobCore(state, job)).resolves.toMatchObject({
      status: "ok",
      summary: "queue changed",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("queue changed", {
      agentId: "finn",
      contextKey: "cron:script-job:script",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: wake === "now" ? "notifications-event" : "cron",
      intent,
      reason: wake === "now" ? "wake" : "cron:script-job:script",
      agentId: "finn",
    });
  });

  it.each([
    {
      name: "main notification and immediate wake use the session owner and thread",
      sessionTarget: "main",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      defaultAgentId: "main",
      notify: "queue changed",
      wake: "now",
      expectedAgentId: "ops",
      expectedIntent: "immediate",
      expectDeliveryContext: true,
    },
    {
      name: "main notification and deferred wake use the current configured owner",
      sessionTarget: "main",
      defaultAgentId: "stale-main",
      currentDefaultAgentId: "ops",
      notify: "queue changed",
      wake: "next-heartbeat",
      expectedAgentId: "ops",
      expectedIntent: "event",
    },
    {
      name: "isolated script wake uses the session owner without main delivery context",
      sessionTarget: "isolated",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      defaultAgentId: "main",
      notify: "queue changed",
      wake: "now",
      expectedAgentId: "ops",
      expectedIntent: "immediate",
    },
    {
      name: "explicit script owner wins over the current configured default",
      sessionTarget: "main",
      agentId: "ops",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      defaultAgentId: "main",
      currentDefaultAgentId: "other",
      notify: "queue changed",
      wake: "next-heartbeat",
      expectedAgentId: "ops",
      expectedIntent: "event",
      expectDeliveryContext: true,
    },
    {
      name: "main wake-only completion keeps its session owner and thread",
      sessionTarget: "main",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      defaultAgentId: "main",
      wake: "now",
      expectedAgentId: "ops",
      expectedIntent: "immediate",
      expectDeliveryContext: true,
    },
    {
      name: "main notification without a wake keeps its session owner and thread",
      sessionTarget: "main",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      defaultAgentId: "main",
      notify: "queue changed",
      expectedAgentId: "ops",
      expectDeliveryContext: true,
    },
  ] as const)("routes script side effects: $name", async (testCase) => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const sessionKey = "sessionKey" in testCase ? testCase.sessionKey : undefined;
    const explicitAgentId = "agentId" in testCase ? testCase.agentId : undefined;
    const currentDefaultAgentId =
      "currentDefaultAgentId" in testCase ? testCase.currentDefaultAgentId : undefined;
    const notify = "notify" in testCase ? testCase.notify : undefined;
    const wake = "wake" in testCase ? testCase.wake : undefined;
    const job = {
      ...createDueScriptJob({ now, sessionTarget: testCase.sessionTarget }),
      agentId: explicitAgentId,
      ...(sessionKey ? { sessionKey } : {}),
    };
    const sessionStorePath = path.join(path.dirname(path.dirname(storePath)), "sessions.json");
    const deliveryContext = {
      channel: "telegram",
      to: "telegram:42",
      accountId: "ops-bot",
      threadId: 77,
    };
    if (sessionKey) {
      await upsertSessionEntryCore(
        { storePath: sessionStorePath, sessionKey },
        {
          sessionId: "ops-telegram-session",
          updatedAt: now,
          delivery: normalizeSessionDeliveryState({ context: deliveryContext }),
        },
      );
    }
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      defaultAgentId: testCase.defaultAgentId,
      ...(currentDefaultAgentId ? { resolveDefaultAgentId: () => currentDefaultAgentId } : {}),
      resolveSessionStorePath: () => sessionStorePath,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        ...(notify ? { notify } : {}),
        ...(wake ? { wake } : {}),
      })),
    });

    await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });

    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    const [eventText, eventOptions] = enqueueSystemEvent.mock.calls[0] as [
      string,
      {
        agentId?: string;
        contextKey?: string;
        deliveryContext?: typeof deliveryContext;
      },
    ];
    expect(eventText).toBe(notify ?? "script job script job completed");
    expect(eventOptions.agentId).toBe(testCase.expectedAgentId);
    if ("expectDeliveryContext" in testCase && testCase.expectDeliveryContext) {
      expect(eventOptions.deliveryContext).toEqual(deliveryContext);
    } else {
      expect(eventOptions).not.toHaveProperty("deliveryContext");
    }
    if ("expectedIntent" in testCase) {
      expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
        source: wake === "now" ? "notifications-event" : "cron",
        intent: testCase.expectedIntent,
        reason: wake === "now" ? "wake" : "cron:script-job:script",
        agentId: testCase.expectedAgentId,
      });
    } else {
      expect(requestHeartbeat).not.toHaveBeenCalled();
    }
  });

  it.each(["main", "isolated"] as const)(
    "does not resolve an owner for a quiet %s script without side effects",
    async (sessionTarget) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-08-24T12:00:00.000Z");
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const resolveDefaultAgentId = vi.fn(() => undefined);
      const job = {
        ...createDueScriptJob({ now, sessionTarget }),
        agentId: undefined,
      };
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        defaultAgentId: undefined,
        resolveDefaultAgentId,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runScriptJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
      expect(resolveDefaultAgentId).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
    },
  );

  it("delivers nothing and enqueues nothing when notify and wake are absent", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        delivered: false,
        deliveryAttempted: false,
      })),
    });

    await expect(
      executeJobCore(state, createDueScriptJob({ now, sessionTarget: "main" })),
    ).resolves.toMatchObject({ status: "ok", scriptStateChanged: true });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects nextCheck without pacing before applying state", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        nextCheck: { delayMs: 5_000 },
      })),
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toEqual({
      status: "error",
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
      errorClassification: { kind: "permanent" },
      failureNotificationDetail: {
        kind: "script-failure",
        source: "payload",
        code: "invalid_input",
      },
    });
  });

  it.each([
    ["ok", { status: "ok" as const, stateChanged: true, state: { revision: 2 } }, 2, 0],
    [
      "error",
      {
        status: "error" as const,
        error: "script threw",
        stateChanged: true,
        state: { revision: 2 },
      },
      1,
      1,
    ],
  ] as const)(
    "persists script state on %s runs only",
    async (_label, outcome, revision, errors) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-07-18T12:00:00.000Z");
      const job = createDueScriptJob({ now });
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runScriptJob: vi.fn(async () => outcome),
      });

      await onTimer(state);

      const stored = await loadCronStore(storePath);
      expect(stored.jobs[0]?.state.triggerState).toEqual({ revision });
      expect(stored.jobs[0]?.state.consecutiveErrors ?? 0).toBe(errors);
    },
  );

  it("clamps a script nextCheck through the shared pacing path", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const job = createDueScriptJob({ now, pacing: { min: "15m", max: "4h" } });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        nextCheck: { delayMs: 5 * 60_000 },
      })),
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    expect(stored.jobs[0]?.state.nextRunAtMs).toBe(now + 15 * 60_000);
    expect(stored.jobs[0]?.state.pacedNextRunAtMs).toBe(now + 15 * 60_000);
  });

  it("records isolated cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "session-run-1",
      delivered: true,
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "isolated-agent-job" }),
        message: "run isolated cron",
      }),
    );
    const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected isolated cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
    expect(task.terminalSummary).toBe("done");
    expect(task.detail).toMatchObject({
      kind: "cron-run",
      status: "ok",
      sessionId: "session-run-1",
      durationMs: 0,
      nextRunAtMs: now + 60_000,
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
  });

  it("records current-bound cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      delivered: true,
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          ...createDueIsolatedAgentJob({ now }),
          sessionTarget: "current",
          sessionKey: "agent:finn:telegram:direct:42",
        },
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected current-bound cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
  });

  it("seeds active scheduled cron task progress for status surfaces", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runResult = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(() => runResult.promise);

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    const timerRun = onTimer(state);
    try {
      await vi.waitFor(() => {
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      });

      const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
      if (!task) {
        throw new Error("expected active cron task ledger record");
      }
      expect(task.status).toBe("running");
      expect(task.progressSummary).toBe("Running automation.");
      expect(formatTaskStatusDetail(task)).toBe("Running automation.");

      runResult.resolve({ status: "ok", summary: "done" });
      await timerRun;
    } finally {
      // Stop new ticks and settle this core before the shared hooks reset its state.
      stop(state);
      runResult.resolve({ status: "ok", summary: "done" });
      try {
        await timerRun;
      } finally {
        await vi.waitFor(() => {
          expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        });
      }
    }
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const ledgerError = new Error("disk full");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRunCore")
      .mockImplementation(() => {
        throw ledgerError;
      });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      { jobId: "main-heartbeat-job", error: ledgerError },
      "cron: failed to create task ledger record",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "main",
      contextKey: "cron:main-heartbeat-job",
    });

    createTaskRecordSpy.mockRestore();
  });
});
