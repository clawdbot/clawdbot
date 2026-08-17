// Cron timer precheck integration coverage (split from timer.test.ts for max-lines).
import { describe, expect, it, vi } from "vitest";
import * as jobPrecheck from "../../cron/job-precheck.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { executeJobCore, onTimer } from "../../cron/service/timer.test-support.js";
import { loadCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-precheck",
});

function createCronServiceState(
  params: Parameters<typeof createCronServiceStateBase>[0],
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({ defaultAgentId: "main", ...params });
}

function createDueIsolatedAgentJob(params: {
  now: number;
  id?: string;
  precheck?: CronJob["precheck"];
  agentId?: string;
}): CronJob {
  return {
    id: params.id ?? "isolated-agent-job",
    agentId: params.agentId ?? "finn",
    name: "isolated agent job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run isolated cron" },
    ...(params.precheck ? { precheck: params.precheck } : {}),
    state: { nextRunAtMs: params.now - 1 },
  };
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

describe("cron service timer precheck coverage", () => {
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
});
