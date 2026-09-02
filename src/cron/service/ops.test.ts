// Cron service ops tests cover high-level service operations and state transitions.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AgentDeletionCommitUncertainError } from "../../agents/agent-lifecycle-registry.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { formatTaskStatusDetail } from "../../tasks/task-status.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createCronExecutionId } from "../run-id.js";
import * as cronSchedule from "../schedule.js";
import { readCronJobScratchState, writeCronJobScratch } from "../scratch-store.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronJobsStoreWithConfigJobs, loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import * as runReceiptStore from "../store/run-receipt-store.js";
import { saveCronJobsStoreWithTransactionHooks } from "../store/transaction-hooks.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import {
  add,
  remove,
  removeAgentJobsTransactional,
  removeStaleJobFamily,
  update,
  updateWithPrecondition,
} from "./ops-mutations.js";
import { list, writeScratch } from "./ops-read.js";
import { inspectManualRunDisposition } from "./ops-run-preparation.js";
import { run } from "./ops-run.js";
import { proposeCronRunRecovery, recoverCronRunProposal } from "./run-recovery.js";
import { createCronServiceState, type CronAddResult, type CronEvent } from "./state.js";
import * as taskRuns from "./task-runs.js";
import { runMissedJobs } from "./timer.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});

function requireDeclarativeAddResult(result: CronAddResult) {
  if (!("job" in result)) {
    throw new Error("expected declarative cron result");
  }
  return result;
}

describe("scheduled tool policy provenance", () => {
  it("guards scratch and removal at their locked mutation owners", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const job = await add(state, {
      name: "guarded",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run" },
    });
    const commitGuard = vi.fn(() => {
      throw new TypeError("authority closed");
    });

    const scratchBlockerEntered = createDeferred();
    const releaseScratchBlocker = createDeferred();
    const scratchBlocker = updateWithPrecondition(state, job.id, {}, async () => {
      scratchBlockerEntered.resolve();
      await releaseScratchBlocker.promise;
    });
    await scratchBlockerEntered.promise;
    const scratchWrite = writeScratch(state, job.id, { content: "notes", commitGuard });
    expect(commitGuard).not.toHaveBeenCalled();
    releaseScratchBlocker.resolve();
    await scratchBlocker;
    await expect(scratchWrite).rejects.toThrow("authority closed");
    expect(readCronJobScratchState(storePath, job.id)).toEqual({ currentRevision: 0 });

    const removeBlockerEntered = createDeferred();
    const releaseRemoveBlocker = createDeferred();
    const removeBlocker = updateWithPrecondition(state, job.id, {}, async () => {
      removeBlockerEntered.resolve();
      await releaseRemoveBlocker.promise;
    });
    await removeBlockerEntered.promise;
    const removal = remove(state, job.id, { commitGuard });
    expect(commitGuard).toHaveBeenCalledOnce();
    releaseRemoveBlocker.resolve();
    await removeBlocker;
    await expect(removal).rejects.toThrow("authority closed");
    expect(state.store?.jobs.some((entry) => entry.id === job.id)).toBe(true);
    expect(commitGuard).toHaveBeenCalledTimes(2);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("consumes add authority only after candidate validation and immediately before mutation", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const commitGuard = vi.fn();
    const invalid = {
      name: "invalid",
      enabled: true,
      schedule: { kind: "cron" as const, expr: "0 0 30 2 *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
    };

    await expect(add(state, invalid, { commitGuard })).rejects.toThrow(/no upcoming run time/);
    expect(commitGuard).not.toHaveBeenCalled();
    expect(state.store?.jobs).toEqual([]);

    const valid = { ...invalid, schedule: { kind: "cron" as const, expr: "0 0 * * *" } };
    commitGuard.mockImplementation(() => {
      expect(state.store?.jobs).toEqual([]);
    });
    await add(state, valid, { commitGuard });
    expect(commitGuard).toHaveBeenCalledOnce();
    expect(state.store?.jobs).toHaveLength(1);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("preserves update authority across a failed precondition and consumes at mutation", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const job = await add(state, {
      name: "original",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run" },
    });
    const commitGuard = vi.fn(() => {
      expect(state.store?.jobs[0]?.name).toBe("original");
      return undefined;
    });

    await expect(
      updateWithPrecondition(
        state,
        job.id,
        { name: "updated" },
        () => {
          throw new Error("revision conflict");
        },
        { commitGuard },
      ),
    ).rejects.toThrow("revision conflict");
    expect(commitGuard).not.toHaveBeenCalled();
    expect(state.store?.jobs[0]?.name).toBe("original");

    await updateWithPrecondition(state, job.id, { name: "updated" }, () => undefined, {
      commitGuard,
    });
    expect(commitGuard).toHaveBeenCalledOnce();
    expect(state.store?.jobs[0]?.name).toBe("updated");
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("stores final-surface provenance privately and never synthesizes it from the default marker", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const base = {
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
    };
    const proven = await add(
      state,
      {
        ...base,
        name: "proven",
        payload: {
          kind: "agentTurn" as const,
          message: "run",
          toolsAllow: ["notes__read"],
          toolsAllowIsDefault: true,
        },
      },
      {
        toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
      },
    );
    expect(proven.toolsAllowProvenance).toEqual({
      version: 1,
      source: "final-executable-surface",
    });

    const legacy = await add(state, {
      ...base,
      name: "legacy-default",
      payload: {
        kind: "agentTurn",
        message: "run",
        toolsAllow: ["notes__read"],
        toolsAllowIsDefault: true,
      },
    });
    expect(legacy.toolsAllowProvenance).toBeUndefined();

    const routine = await update(state, proven.id, { description: "keep" });
    expect(routine.toolsAllowProvenance).toEqual(proven.toolsAllowProvenance);
    const explicit = await update(state, proven.id, {
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(explicit.toolsAllowProvenance).toBeUndefined();
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("stamps, preserves, replaces, and clears private runtime authority at mutation ownership", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({
      storePath,
      now: Date.now(),
      triggersEnabled: true,
    });
    const baseAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const job = await add(
      state,
      {
        name: "runtime-capped",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "run", toolsAllow: ["*"] },
      },
      { captureRuntimeAuthority: () => baseAuthority },
    );
    expect(job.runtimeAuthority).toEqual(baseAuthority);

    const routine = await update(state, job.id, { description: "preserve" });
    expect(routine.runtimeAuthority).toEqual(baseAuthority);

    const commitGuard = vi.fn();
    const validated = await update(
      state,
      job.id,
      { description: "preserve after validation" },
      { commitGuard },
    );
    expect(commitGuard).toHaveBeenCalledOnce();
    expect(validated.runtimeAuthority).toEqual(baseAuthority);

    const explicit = await update(state, job.id, {
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(explicit.runtimeAuthority).toBeUndefined();
    expect(explicit.runtimeAuthorityRecoveryRequired).toBe(true);
    const persistedExplicit = (await loadCronStore(storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(persistedExplicit?.runtimeAuthority).toBeUndefined();
    expect(persistedExplicit?.runtimeAuthorityRecoveryRequired).toBe(true);

    const replacement = { ...baseAuthority, payload: { apps: [{ id: "mail" }] } };
    const replaced = await update(
      state,
      job.id,
      { description: "recaptured" },
      { captureRuntimeAuthority: () => replacement },
    );
    expect(replaced.runtimeAuthority).toEqual(replacement);
    expect(replaced.runtimeAuthorityRecoveryRequired).toBeUndefined();
    const persistedReplacement = (await loadCronStore(storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(persistedReplacement?.runtimeAuthority).toEqual(replacement);
    expect(persistedReplacement?.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const freshEmptyCapture = await update(
      state,
      job.id,
      { description: "recaptured without runtime authority" },
      { captureRuntimeAuthority: () => undefined },
    );
    expect(freshEmptyCapture.runtimeAuthority).toBeUndefined();
    expect(freshEmptyCapture.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const triggeredTransport = await add(
      state,
      {
        name: "trigger-capped",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        trigger: { script: "return true" },
        payload: { kind: "command", argv: ["true"] },
      },
      { captureRuntimeAuthority: () => baseAuthority },
    );
    expect(triggeredTransport.runtimeAuthority).toEqual(baseAuthority);
    const nonToolRuntime = await update(state, triggeredTransport.id, { trigger: null });
    expect(nonToolRuntime.runtimeAuthority).toBeUndefined();
    expect(nonToolRuntime.runtimeAuthorityRecoveryRequired).toBeUndefined();
    const persistedNonToolRuntime = (await loadCronStore(storePath)).jobs.find(
      (entry) => entry.id === triggeredTransport.id,
    );
    expect(persistedNonToolRuntime?.runtimeAuthority).toBeUndefined();
    expect(persistedNonToolRuntime?.runtimeAuthorityRecoveryRequired).toBeUndefined();
    const persistedAuthorityRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT job_id FROM cron_job_runtime_authorities WHERE job_id = ?")
        .get(triggeredTransport.id),
    );
    expect(persistedAuthorityRow).toBeUndefined();
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("keeps declarative runtime authority across validation and replaces it only on capture", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const baseAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const input = {
      declarationKey: "plugin:test:runtime-authority",
      name: "declarative runtime authority",
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["*"] },
    };
    const created = requireDeclarativeAddResult(
      await add(state, input, {
        captureRuntimeAuthority: () => baseAuthority,
      }),
    );
    expect(created.job.runtimeAuthority).toEqual(baseAuthority);

    const commitGuard = vi.fn();
    const validated = requireDeclarativeAddResult(
      await add(
        state,
        {
          ...input,
          description: "validated",
          payload: { kind: "agentTurn", message: "run" },
        },
        { commitGuard },
      ),
    );
    expect(commitGuard).toHaveBeenCalledOnce();
    expect(validated.job.runtimeAuthority).toEqual(baseAuthority);

    const cleared = requireDeclarativeAddResult(
      await add(state, {
        ...input,
        description: "new tool cap",
        payload: { ...input.payload, toolsAllow: ["read"] },
      }),
    );
    expect(cleared.job.runtimeAuthority).toBeUndefined();
    expect(cleared.job.runtimeAuthorityRecoveryRequired).toBe(true);

    const replacement = { ...baseAuthority, payload: { apps: [{ id: "mail" }] } };
    const recaptured = requireDeclarativeAddResult(
      await add(
        state,
        {
          ...input,
          description: "recaptured",
          payload: { ...input.payload, toolsAllow: ["read"] },
        },
        { captureRuntimeAuthority: () => replacement },
      ),
    );
    expect(recaptured.job.runtimeAuthority).toEqual(replacement);
    expect(recaptured.job.runtimeAuthorityRecoveryRequired).toBeUndefined();
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("stamps trusted and authenticated-account creates", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const base = {
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["write"] },
    };

    const trusted = await add(state, { ...base, name: "trusted" });
    expect(trusted.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });

    const account = await add(
      state,
      {
        ...base,
        name: "account",
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
      },
      {
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
      },
    );
    expect(account.scheduledToolPolicy).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("keeps routine legacy edits restrictive and adopts authority on an explicit tool edit", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const created = await add(state, {
      name: "legacy",
      enabled: true,
      owner: {
        agentId: "main",
        sessionKey: "agent:main:discord:group:ops",
        accountId: "work",
      },
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
    });
    delete created.scheduledToolPolicy;

    const routine = await update(state, created.id, { description: "routine" });
    expect(routine.scheduledToolPolicy).toBeUndefined();

    const reauthorized = await update(
      state,
      created.id,
      { payload: { kind: "agentTurn", toolsAllow: ["write"] } },
      {
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
      },
    );
    expect(reauthorized.scheduledToolPolicy?.mode).toBe("account");
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });
});

async function withStateDirForStorePath<T>(
  storePath: string,
  runWithStateDir: () => Promise<T>,
): Promise<T> {
  const stateRoot = path.dirname(path.dirname(storePath));
  resetTaskRegistryForTests();
  try {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, runWithStateDir);
  } finally {
    resetTaskRegistryForTests();
  }
}

function createTimedOutIsolatedCronState(params: { storePath: string; now: number }) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => {
      throw new Error("cron: job execution timed out");
    }),
  });
}

function createOkIsolatedCronState(params: {
  storePath: string;
  now: number;
  summary?: string;
  onEvent?: (event: CronEvent) => void;
  triggersEnabled?: boolean;
}) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    ...(params.triggersEnabled ? { cronConfig: { triggers: { enabled: true } } } : {}),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      delivered: true,
      ...(params.summary === undefined ? {} : { summary: params.summary }),
    })),
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}

function createFutureEveryJob(params: { id: string; now: number; nextRunAtMs?: number }): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: params.id },
    state: params.nextRunAtMs === undefined ? {} : { nextRunAtMs: params.nextRunAtMs },
  };
}

function createInterruptedMainJob(now: number): CronJob {
  return {
    id: "startup-interrupted",
    name: "startup interrupted",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "should not replay on startup" },
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
      lastFailureNotificationDelivered: true,
      lastFailureNotificationDeliveryStatus: "delivered",
    },
  };
}

function createDueIsolatedJob(now: number): CronJob {
  return {
    id: "isolated-timeout",
    name: "isolated timeout",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  };
}

async function writeDueIsolatedJobSnapshot(storePath: string, now: number) {
  await writeCronStoreSnapshot({
    storePath,
    jobs: [createDueIsolatedJob(now)],
  });
}

async function writeLegacyCronArraySnapshot(storePath: string, jobs: CronJob[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(jobs, null, 2), "utf-8");
}

function insertCronJobRow(storePath: string, job: CronJob) {
  const { state, ...jobConfig } = job;
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      `INSERT INTO cron_jobs (
        store_key, job_id, declaration_key, name, description, enabled, payload_kind,
        job_json, state_json, updated_at
      ) VALUES (
        $storeKey, $jobId, $declarationKey, $name, $description, $enabled, $payloadKind,
        $jobJson, $stateJson, $updatedAt
      )`,
    ).run({
      $storeKey: path.resolve(storePath),
      $jobId: job.id,
      $declarationKey: job.declarationKey ?? null,
      $name: job.name,
      $description: job.description ?? null,
      $enabled: job.enabled ? 1 : 0,
      $payloadKind: job.payload.kind,
      $jobJson: JSON.stringify(jobConfig),
      $stateJson: JSON.stringify(state),
      $updatedAt: job.updatedAtMs,
    });
  });
}

describe("cron stale job-family adoption", () => {
  it("removes owner-tagged legacy rows outside the active store", async () => {
    const { storePath } = await makeStorePath();
    const staleStorePath = path.join(path.dirname(storePath), "legacy-copy", "jobs.json");
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const family = {
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: "Memory Dreaming Promotion",
      ownerPluginTag: "[managed-by=memory-core.short-term-promotion]",
    };
    await add(state, {
      declarationKey: family.declarationKey,
      name: family.name,
      description: `${family.ownerPluginTag} current`,
      enabled: true,
      schedule: { kind: "cron", expr: "*/3 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "dream" },
    });
    const legacy = {
      id: "75e182e6-8728-43ae-832b-01f50702feed",
      name: family.name,
      description: `${family.ownerPluginTag} legacy`,
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "cron" as const, expr: "0 3 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "dream" },
      state: {},
    } satisfies CronJob;
    insertCronJobRow(staleStorePath, legacy);
    insertCronJobRow(staleStorePath, {
      ...legacy,
      id: "operator-same-name",
      description: "Operator-owned job with the same display name",
    });

    await expect(removeStaleJobFamily(state, family)).resolves.toBe(1);

    const remaining = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT store_key, job_id FROM cron_jobs WHERE name = ? ORDER BY job_id")
        .all(family.name),
    );
    expect(remaining).toHaveLength(2);
    expect(remaining).toEqual(
      expect.arrayContaining([
        { store_key: path.resolve(storePath), job_id: expect.any(String) },
        { store_key: path.resolve(staleStorePath), job_id: "operator-same-name" },
      ]),
    );
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });
});

async function expectDueIsolatedManualRunProgresses(storePath: string, now: number) {
  const state = createOkIsolatedCronState({ storePath, now, summary: "done" });

  await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

  const persisted = (await loadCronStore(storePath)) as {
    jobs: CronJob[];
  };
  expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
  expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
}

function expectWarnedJob(params: { field: "jobId" | "jobStatus"; value: string; message: string }) {
  const warnCalls = logger.warn.mock.calls as unknown as Array<[Record<string, unknown>, string]>;
  const warning = warnCalls.find(
    ([metadata, message]) => metadata[params.field] === params.value && message === params.message,
  );
  expect(warning?.[0][params.field]).toBe(params.value);
  expect(warning?.[1]).toBe(params.message);
}

function expectTaskRun(params: {
  runId: string;
  runtime: string;
  status: string;
  sourceId: string;
  progressSummary?: string;
}) {
  const task = findCronTaskByBaseRunId(params.runId);
  expect(task?.runtime).toBe(params.runtime);
  expect(task?.status).toBe(params.status);
  expect(task?.sourceId).toBe(params.sourceId);
  if (params.progressSummary !== undefined) {
    expect(task?.progressSummary).toBe(params.progressSummary);
  }
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return (
    findTaskByRunId(baseRunId) ??
    listTaskRecordsUnsorted().find((task) => task.runId?.startsWith(`${baseRunId}:`))
  );
}

function createMissedIsolatedJob(now: number): CronJob {
  return {
    id: "startup-timeout",
    name: "startup timeout",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "should timeout" },
    sessionKey: "agent:main:main",
    state: {
      nextRunAtMs: now - 60_000,
    },
  };
}

describe("cron service ops seam coverage", () => {
  it("keeps core add paths on SQLite and leaves legacy JSON for doctor migration", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-05-20T08:00:00.000Z");
    const legacyJobs: CronJob[] = [
      {
        id: "legacy-alpha",
        name: "legacy alpha",
        enabled: true,
        createdAtMs: now - 120_000,
        updatedAtMs: now - 120_000,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "alpha" },
        state: { nextRunAtMs: now + 3_600_000 },
      },
      {
        id: "legacy-beta",
        name: "legacy beta",
        enabled: true,
        createdAtMs: now - 60_000,
        updatedAtMs: now - 60_000,
        schedule: { kind: "every", everyMs: 7_200_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "beta" },
        state: { nextRunAtMs: now + 7_200_000 },
      },
    ];
    await writeLegacyCronArraySnapshot(storePath, legacyJobs);
    const state = createOkIsolatedCronState({ storePath, now });

    const newJob = await add(state, {
      name: "new after upgrade",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_800_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "new" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronStore(storePath);

    expect(loaded.jobs.map((job) => job.id)).toEqual([newJob.id]);
    expect(await fs.stat(storePath)).toBeTruthy();
    await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts and lists future jobs after upgrading from a database without receipts", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-05-20T08:30:00.000Z");
    const job = createFutureEveryJob({ id: "pre-receipt-upgrade", now });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    openOpenClawStateDatabase().db.exec("DROP TABLE cron_run_receipts");
    const state = createOkIsolatedCronState({ storePath, now });

    try {
      await start(state);

      await expect(list(state)).resolves.toEqual([
        expect.objectContaining({ id: job.id, enabled: true }),
      ]);
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'cron_run_receipts'",
          )
          .get(),
      ).toEqual({ name: "cron_run_receipts" });
    } finally {
      stop(state);
      runReceiptStore.inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    }
  });

  it("leaves legacy notify fallback for doctor instead of migrating during startup", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-05-20T09:00:00.000Z");
    const legacyJob = {
      id: "legacy-notify",
      name: "legacy notify",
      enabled: true,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 60_000,
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: now },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
      delivery: { to: "telegram:chat-1" },
      notify: true,
      state: { nextRunAtMs: now + 3_600_000 },
    } as CronJob & { notify: true };
    insertCronJobRow(storePath, legacyJob);
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { webhook: "https://example.invalid/cron" } as never,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = loaded.store.jobs[0] as CronJob & { notify?: unknown };
    expect(persisted.notify).toBeUndefined();
    expect(persisted.delivery).toEqual({
      mode: "announce",
      to: "telegram:chat-1",
    });
    expect(loaded.configJobs[0]?.notify).toBe(true);
    expect(logger.info).not.toHaveBeenCalledWith(
      { storePath },
      "cron: migrated legacy notify fallback jobs before scheduler startup",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ storePath }),
      "cron: legacy notify fallback jobs need cron.webhook before migration",
    );
  });

  it("start marks interrupted running jobs failed, persists, and arms the timer", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createInterruptedMainJob(now)],
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

    await start(state);

    expectWarnedJob({
      field: "jobId",
      value: "startup-interrupted",
      message: "cron: marking interrupted running job failed on startup",
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    if (state.timer === undefined) {
      throw new Error("Expected cron service timer");
    }

    const persisted = (await loadCronStore(storePath)) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted cron job");
    }
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.lastRunStatus).toBe("error");
    expect(job.state.lastRunAtMs).toBe(now - 30 * 60_000);
    expect(job.state.lastError).toBe("cron: job interrupted by gateway restart");
    expect(job.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(job.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
    expect(job.state.lastFailureNotificationDeliveryError).toBeUndefined();
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    const positiveDelays = delays.filter((delay) => delay > 0);
    expect(positiveDelays.length).toBeGreaterThan(0);

    timeoutSpy.mockRestore();
    stop(state);
  });

  it("commits an interrupted-run auto-disable before notifying", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const job = createInterruptedMainJob(now);
    job.state.consecutiveErrors = 9;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const order: string[] = [];
    const enqueueSystemEvent = vi.fn(() => {
      const row = runOpenClawStateWriteTransaction(({ db }) =>
        db.prepare("SELECT enabled FROM cron_jobs WHERE job_id = ?").get(job.id),
      ) as { enabled: number };
      expect(row.enabled).toBe(0);
      order.push("notify");
    });
    const requestHeartbeat = vi.fn(() => {
      expect(order.at(-1)).toBe("notify");
      order.push("heartbeat");
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

    await start(state);

    expect(order).toEqual(["notify", "heartbeat"]);
    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      enabled: false,
      state: {
        autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
      },
    });
    stop(state);
  });

  it("preserves a foreign completion committed after recovery is proposed", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    const job = createInterruptedMainJob(now);
    job.state.runningAtMs = startedAt;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const preparedReceipt = runReceiptStore.prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "main",
      startedAtMs: startedAt,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      runReceiptStore.claimCronRunReceiptInDatabase({
        database: db,
        prepared: preparedReceipt,
        resolveAgentId: (current) => current.agentId ?? "main",
      }),
    );
    const completedJob = structuredClone(job);
    delete completedJob.state.runningAtMs;
    completedJob.state.lastRunAtMs = startedAt;
    completedJob.state.lastRunStatus = "ok";
    completedJob.state.lastStatus = "ok";
    completedJob.state.nextRunAtMs = now + 60_000;
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAt);
    await saveCronJobsStoreWithTransactionHooks(
      storePath,
      { version: 1, jobs: [completedJob] },
      undefined,
      {
        afterWrite: (db) => {
          runReceiptStore.finishCronRunReceiptInDatabase({
            database: db,
            handle: receipt,
            status: "ok",
            finishedAtMs: now,
          });
        },
      },
    );
    runReceiptStore.releaseLocalCronRunReceiptOwnership(receipt);

    expect(recoverCronRunProposal(state, proposal)).toEqual({ kind: "superseded" });

    await start(state);

    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state).toMatchObject({
      lastRunAtMs: startedAt,
      lastRunStatus: "ok",
      lastStatus: "ok",
    });
    expect(persisted?.state.nextRunAtMs).toEqual(expect.any(Number));
    expect(persisted?.state.runningAtMs).toBeUndefined();
    expect(persisted?.state.lastError).toBeUndefined();
    stop(state);
  });

  it.each([
    { outcome: "restores", identity: "canonical receipt-keyed", receipt: true },
    {
      outcome: "fails closed for",
      identity: "pre-upgrade reservation-keyed",
      receipt: true,
      reservationOffsetMs: 250,
    },
    { outcome: "restores", identity: "canonical receiptless", receipt: false },
    {
      outcome: "fails closed for",
      identity: "receiptless reservation-keyed",
      receipt: false,
      reservationOffsetMs: 250,
    },
    {
      outcome: "fails closed for",
      identity: "receiptless foreign",
      receipt: false,
      foreignRunId: "foreign-run",
    },
  ])(
    "$outcome a finalized $identity task run when startup finds its stale marker",
    async ({ outcome, receipt: hasReceipt, reservationOffsetMs, foreignRunId }) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const startedAt = now - 30 * 60_000 + 250;
      const endedAt = startedAt + 4_000;

      await withStateDirForStorePath(storePath, async () => {
        const job = createInterruptedMainJob(now);
        job.state.runningAtMs = startedAt;
        job.trigger = { script: "json({ fire: true })", once: true };
        job.payload = { kind: "script", script: "return { state: { cursor: 'payload' } }" };
        job.state.triggerState = { cursor: "old" };
        await writeCronStoreSnapshot({ storePath, jobs: [job] });
        const preparedReceipt = runReceiptStore.prepareCronRunReceiptClaim({
          storePath,
          job,
          agentId: "main",
          startedAtMs: startedAt,
        });
        const receipt = hasReceipt
          ? runOpenClawStateWriteTransaction(({ db }) =>
              runReceiptStore.claimCronRunReceiptInDatabase({
                database: db,
                prepared: preparedReceipt,
                resolveAgentId: (current) => current.agentId ?? "main",
              }),
            )
          : undefined;
        const events: CronEvent[] = [];
        const state = createCronServiceState({
          storePath,
          cronEnabled: true,
          log: logger,
          nowMs: () => now,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          onEvent: (event) => events.push(structuredClone(event)),
        });
        const taskRunId =
          reservationOffsetMs === undefined && foreignRunId === undefined
            ? taskRuns.tryCreateCronTaskRunHandle({ state, job, startedAt, runReceipt: receipt })
                ?.runId
            : taskExecutor.createRunningTaskRunCore({
                runtime: "cron",
                sourceId: job.id,
                ownerKey: "",
                scopeKind: "system",
                runId:
                  foreignRunId ??
                  `${createCronExecutionId(job.id, startedAt - reservationOffsetMs!)}:legacy-upgrade`,
                agentId: "main",
                task: job.name,
                deliveryStatus: "not_applicable",
                notifyPolicy: "silent",
                startedAt,
                lastEventAt: startedAt,
                detail: { storeKey: cronStoreKey(storePath) },
              })?.runId;
        if (!taskRunId) {
          throw new Error("expected reserved cron task run");
        }

        taskRuns.tryFinishCronTaskRun(state, {
          taskRunId,
          job,
          triggerEval: { fired: true, stateChanged: true, state: { cursor: "new" } },
          scriptResult: { scriptStateChanged: true, scriptState: { cursor: "payload" } },
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "ok",
            summary: "completed before crash",
            delivered: true,
            deliveryStatus: "delivered",
            failureNotificationDelivery: { status: "not-requested" },
            runAtMs: startedAt,
            durationMs: endedAt - startedAt,
            triggerFired: true,
          },
        });

        if (receipt) {
          runReceiptStore.releaseLocalCronRunReceiptOwnership(receipt);
        }
        await start(state);

        expect(findTaskByRunId(taskRunId)).toMatchObject({
          status: "succeeded",
          startedAt,
          terminalSummary: "completed before crash",
          endedAt,
          detail: {
            kind: "cron-run",
            status: "ok",
            triggerFired: true,
            scriptStateChanged: true,
            scriptState: { cursor: "payload" },
          },
        });
        const persisted = await loadCronStore(storePath);
        const receiptRow = receipt
          ? (runOpenClawStateWriteTransaction(({ db }) =>
              db
                .prepare(
                  "SELECT status, finished_at_ms AS finishedAtMs, error_text AS error FROM cron_run_receipts WHERE receipt_id = ?",
                )
                .get(receipt.receiptId),
            ) as { status: string; finishedAtMs: number; error: string | null })
          : undefined;
        if (outcome === "fails closed for") {
          expect(persisted.jobs[0]?.state).toMatchObject({
            lastRunAtMs: startedAt,
            lastRunStatus: "error",
            lastStatus: "error",
            lastError: "cron: job interrupted by gateway restart",
            triggerState: { cursor: "old" },
          });
          expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
          if (receipt) {
            expect(receiptRow).toEqual({
              status: "interrupted",
              finishedAtMs: now,
              error: "cron: job interrupted because owner is unavailable",
            });
          }
          expect(events.filter((event) => event.action === "finished")).toEqual([
            expect.objectContaining({
              jobId: job.id,
              status: "error",
              error: "cron: job interrupted by gateway restart",
            }),
          ]);
          stop(state);
          return;
        }
        expect(persisted.jobs[0]).toMatchObject({
          enabled: false,
          state: {
            lastRunAtMs: startedAt,
            lastRunStatus: "ok",
            lastStatus: "ok",
            lastDurationMs: endedAt - startedAt,
            lastDelivered: true,
            lastDeliveryStatus: "delivered",
            lastTriggerEvalAtMs: endedAt,
            lastTriggerFireAtMs: endedAt,
            triggerState: { cursor: "payload" },
          },
        });
        expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
        expect(persisted.jobs[0]?.state.lastError).toBeUndefined();
        expect(persisted.jobs[0]?.state.nextRunAtMs).toBeUndefined();
        if (receipt) {
          expect(receiptRow).toEqual({ status: "ok", finishedAtMs: endedAt, error: null });
        }
        expect(events.filter((event) => event.action === "finished")).toEqual([]);
        stop(state);
      });
    },
  );

  it("keeps an interrupted receipt when finalized task restoration is invalid", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    await withStateDirForStorePath(storePath, async () => {
      const job = createInterruptedMainJob(now);
      job.id = "invalid-finalized-receipt";
      job.state.runningAtMs = startedAt;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const preparedReceipt = runReceiptStore.prepareCronRunReceiptClaim({
        storePath,
        job,
        agentId: "main",
        startedAtMs: startedAt,
      });
      const receipt = runOpenClawStateWriteTransaction(({ db }) =>
        runReceiptStore.claimCronRunReceiptInDatabase({
          database: db,
          prepared: preparedReceipt,
          resolveAgentId: (current) => current.agentId ?? "main",
        }),
      );
      runReceiptStore.releaseLocalCronRunReceiptOwnership(receipt);
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const taskRunId = taskRuns.tryCreateCronTaskRunHandle({
        state,
        job,
        startedAt,
        runReceipt: receipt,
      })?.runId;
      if (!taskRunId) {
        throw new Error("expected invalid finalized cron task run");
      }
      taskRuns.tryFinishCronTaskRun(state, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "ok",
          completionStatus: "succeeded",
          runAtMs: startedAt,
          durationMs: 1_000,
        },
      });
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare("UPDATE task_runs SET ended_at = -1 WHERE run_id = ?").run(taskRunId);
      });

      await start(state);

      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.lastRunStatus).toBe("error");
      const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
        db
          .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
          .get(receipt.receiptId),
      ) as { status: string };
      expect(receiptRow.status).toBe("interrupted");
      stop(state);
    });
  });

  it("prunes scratch when startup deletes a finalized delete-after-run one-shot", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    const endedAt = startedAt + 4_000;

    await withStateDirForStorePath(storePath, async () => {
      const job = createDueIsolatedJob(now);
      job.id = "startup-finalized-delete-after-run";
      job.name = "startup finalized delete after run";
      job.deleteAfterRun = true;
      job.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
      job.state = { runningAtMs: startedAt, nextRunAtMs: startedAt };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      expect(
        writeCronJobScratch({
          storePath,
          jobId: job.id,
          content: "completed one-shot scratch",
          nowMs: startedAt,
        }),
      ).toMatchObject({ ok: true, currentRevision: 1 });

      const events: CronEvent[] = [];
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        onEvent: (event) => events.push(structuredClone(event)),
      });
      const taskRunId = taskRuns.tryCreateCronTaskRunHandle({ state, job, startedAt })?.runId;
      if (!taskRunId) {
        throw new Error("expected cron task run");
      }
      taskRuns.tryFinishCronTaskRun(state, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "ok",
          completionStatus: "succeeded",
          delivered: true,
          deliveryStatus: "delivered",
          summary: "completed before restart",
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
        },
      });

      try {
        await start(state);

        expect((await loadCronStore(storePath)).jobs).toEqual([]);
        expect(readCronJobScratchState(storePath, job.id)).toEqual({ currentRevision: 0 });
        expect(
          events.filter((event) => event.action === "finished" || event.action === "removed"),
        ).toEqual([]);

        const replacement = await add(state, {
          id: job.id,
          name: "same-id replacement",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "replacement work" },
        });
        expect(replacement.id).toBe(job.id);
        expect(readCronJobScratchState(storePath, job.id)).toEqual({ currentRevision: 0 });
      } finally {
        stop(state);
      }
    });
  });

  it("keeps a finalized one-shot disabled when startup restores its stale marker", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    const endedAt = startedAt + 4_000;

    await withStateDirForStorePath(storePath, async () => {
      const job = createDueIsolatedJob(now);
      job.id = "startup-post-execution-conflict";
      job.name = "startup post-execution conflict";
      job.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
      job.state = { runningAtMs: startedAt, nextRunAtMs: startedAt };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const taskRunId = taskRuns.tryCreateCronTaskRunHandle({ state, job, startedAt })?.runId;
      if (!taskRunId) {
        throw new Error("expected cron task run");
      }
      taskRuns.tryFinishCronTaskRun(state, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
        },
      });

      await start(state);

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]?.enabled).toBe(false);
      expect(persisted.jobs[0]?.state.nextRunAtMs).toBeUndefined();
      stop(state);
    });
  });

  it.each([
    { deleteAfterRun: false, status: "ok" as const, overdue: false },
    { deleteAfterRun: false, status: "error" as const, overdue: false },
    { deleteAfterRun: false, status: "skipped" as const, overdue: false },
    { deleteAfterRun: true, status: "ok" as const, overdue: false },
    { deleteAfterRun: true, status: "error" as const, overdue: false },
    { deleteAfterRun: true, status: "skipped" as const, overdue: false },
    { deleteAfterRun: false, status: "ok" as const, overdue: true },
    { deleteAfterRun: false, status: "error" as const, overdue: true },
    { deleteAfterRun: false, status: "skipped" as const, overdue: true },
    { deleteAfterRun: true, status: "ok" as const, overdue: true },
    { deleteAfterRun: true, status: "error" as const, overdue: true },
    { deleteAfterRun: true, status: "skipped" as const, overdue: true },
  ])(
    "recovers a rescheduled one-shot after a finalized $status run (deleteAfterRun=$deleteAfterRun, overdue=$overdue)",
    async ({ deleteAfterRun, status, overdue }) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const startedAt = now - 30_000;
      const endedAt = startedAt + 4_000;
      const replacementAt = overdue ? now - 5_000 : now + 3_600_000;

      await withStateDirForStorePath(storePath, async () => {
        const replacement = createDueIsolatedJob(now);
        replacement.id = `startup-rescheduled-finalized-one-shot-${deleteAfterRun}`;
        replacement.name = "startup rescheduled finalized one-shot";
        replacement.deleteAfterRun = deleteAfterRun;
        replacement.schedule = { kind: "at", at: new Date(replacementAt).toISOString() };
        replacement.updatedAtMs = now - 10_000;
        replacement.state = { runningAtMs: startedAt, nextRunAtMs: replacementAt };
        await writeCronStoreSnapshot({ storePath, jobs: [replacement] });

        const original = structuredClone(replacement);
        original.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
        original.updatedAtMs = startedAt;
        original.state.nextRunAtMs = startedAt;

        const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
        const state = createCronServiceState({
          storePath,
          cronEnabled: true,
          log: logger,
          nowMs: () => now,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
        });
        const taskRunId = taskRuns.tryCreateCronTaskRunHandle({
          state,
          job: original,
          startedAt,
        })?.runId;
        if (!taskRunId) {
          throw new Error("expected cron task run");
        }
        taskRuns.tryFinishCronTaskRun(state, {
          taskRunId,
          job: original,
          event: {
            jobId: original.id,
            action: "finished",
            job: original,
            status,
            completionStatus: status === "ok" ? "succeeded" : "failed",
            ...(status === "error" ? { error: "original failed before restart" } : {}),
            summary: "original completed before restart",
            runAtMs: startedAt,
            durationMs: endedAt - startedAt,
          },
        });

        try {
          await start(state);

          const persisted = await loadCronStore(storePath);
          const restored = persisted.jobs.find((job) => job.id === replacement.id);
          expect(restored?.enabled).toBe(true);
          if (overdue) {
            expect(restored?.state.nextRunAtMs).toBeGreaterThan(now);
            expect(restored?.state.startupCatchupAtMs).toBe(restored?.state.nextRunAtMs);
          } else {
            expect(restored?.state.nextRunAtMs).toBe(replacementAt);
            expect(restored?.state.startupCatchupAtMs).toBeUndefined();
          }
          expect(restored?.state.runningAtMs).toBeUndefined();
          expect(restored?.state.lastRunAtMs).toBe(startedAt);
          expect(restored?.state.lastRunStatus).toBe(status);
          expect(runIsolatedAgentJob).not.toHaveBeenCalled();
          expect(findTaskByRunId(taskRunId)?.status).toBe(status === "ok" ? "succeeded" : "failed");
        } finally {
          stop(state);
        }
      });
    },
  );

  it("restores finalized failure-alert cooldown without redelivery", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30 * 60_000;
    const endedAt = startedAt + 4_000;

    await withStateDirForStorePath(storePath, async () => {
      const job = createInterruptedMainJob(now);
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        sendCronFailureAlert,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      taskRuns.tryFinishCronTaskRun(state, {
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: "provider unavailable",
          failureNotificationDelivery: { status: "unknown" },
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
          nextRunAtMs: now + 30 * 60_000,
        },
      });

      await start(state);

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]?.state.lastFailureAlertAtMs).toBe(endedAt);
      expect(persisted.jobs[0]?.state.consecutiveErrors).toBe(1);
      expect(persisted.jobs[0]?.state.lastFailureNotificationDelivered).toBeUndefined();
      expect(persisted.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");
      expect(persisted.jobs[0]?.state.lastFailureNotificationDeliveryError).toBeUndefined();
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      stop(state);
    });
  });

  it("start persists load-time updatedAtMs repairs to the state sidecar only", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const createdAtMs = now - 86_400_000;
    const nextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");
    const jobId = "future-sidecar-repair";
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: jobId,
          name: "future sidecar repair",
          enabled: true,
          createdAtMs,
          updatedAtMs: createdAtMs,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "daily" },
          state: { nextRunAtMs },
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
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    try {
      await start(state);

      const persisted = await loadCronStore(storePath);
      const job = persisted.jobs.find((entry) => entry.id === jobId);

      await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(job?.updatedAtMs).toBe(createdAtMs);
      expect(job?.state?.nextRunAtMs).toBe(nextRunAtMs);
    } finally {
      stop(state);
    }
  });

  it("keeps manual acknowledgement IDs separate from recoverable task run IDs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);

      const state = createOkIsolatedCronState({ storePath, now, summary: "done" });
      const manualRunId = `manual:isolated-timeout:${now}:1`;

      await expect(
        run(state, "isolated-timeout", "force", { runId: manualRunId }),
      ).resolves.toEqual({
        ok: true,
        ran: true,
      });

      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT receipt_id AS receiptId FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC, receipt_id DESC LIMIT 1",
        )
        .get(cronStoreKey(storePath), "isolated-timeout") as { receiptId: string };
      const taskRunId = `cron:isolated-timeout:${now}:${receipt.receiptId}:${manualRunId}`;
      expectTaskRun({
        runId: taskRunId,
        runtime: "cron",
        status: "succeeded",
        sourceId: "isolated-timeout",
        progressSummary: "Running automation.",
      });
      expect(findTaskByRunId(manualRunId)).toBeUndefined();
    });
  });

  it("persists successful script state from a manual run", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const job: CronJob = {
      id: "manual-script-state",
      name: "manual script state",
      enabled: true,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 60_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "script", script: "return { state: { revision: 2 } }" },
      state: { nextRunAtMs: now - 1, triggerState: { revision: 1 } },
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
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
      })),
    });

    await expect(run(state, job.id)).resolves.toEqual({ ok: true, ran: true });

    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs[0]?.state.triggerState).toEqual({ revision: 2 });
  });

  it("records timed out manual runs as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);

      const state = createTimedOutIsolatedCronState({
        storePath,
        now,
      });

      await run(state, "isolated-timeout");

      expectTaskRun({
        runId: `cron:isolated-timeout:${now}`,
        runtime: "cron",
        status: "timed_out",
        sourceId: "isolated-timeout",
      });
      expect(findCronTaskByBaseRunId(`cron:isolated-timeout:${now}`)?.detail).toMatchObject({
        kind: "cron-run",
        status: "error",
        runAtMs: now,
        durationMs: 0,
      });
    });
  });

  it("records failed manual runs with cron outcome detail", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: "provider failed",
          provider: "openai",
          model: "gpt-test",
        })),
      });

      await run(state, "isolated-timeout");

      const task = findCronTaskByBaseRunId(`cron:isolated-timeout:${now}`);
      expect(task).toMatchObject({
        status: "failed",
        error: "provider failed",
        detail: {
          kind: "cron-run",
          status: "error",
          provider: "openai",
          model: "gpt-test",
          runAtMs: now,
          durationMs: 0,
        },
      });
    });
  });

  it("does not reschedule a manual lifecycle conflict after execution starts", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const job = createDueIsolatedJob(now);
    job.id = "manual-post-execution-conflict";
    job.name = "manual post-execution conflict";
    job.schedule = { kind: "at", at: new Date(now - 1).toISOString() };

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
          executionStarted: true,
        })),
      });

      await expect(run(state, job.id)).resolves.toEqual({ ok: true, ran: true });

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]).toMatchObject({
        id: job.id,
        enabled: false,
        state: {
          consecutiveErrors: 1,
        },
      });
      expect(persisted.jobs[0]?.state.nextRunAtMs).toBeUndefined();
    });
  });

  it("keeps manual cron runs progressing when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedJob(now)],
    });

    const createTaskRecord = taskExecutor.createRunningTaskRunCore;
    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRunCore")
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      })
      .mockImplementation((params) => createTaskRecord(params));

    try {
      await expectDueIsolatedManualRunProgresses(storePath, now);
      expectWarnedJob({
        field: "jobId",
        value: "isolated-timeout",
        message: "cron: failed to create task ledger record",
      });
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT receipt_id AS receiptId FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC, receipt_id DESC LIMIT 1",
        )
        .get(cronStoreKey(storePath), "isolated-timeout") as { receiptId: string };
      expect(findTaskByRunId(`cron:isolated-timeout:${now}:${receipt.receiptId}`)).toMatchObject({
        status: "succeeded",
      });
    } finally {
      createTaskRecordSpy.mockRestore();
    }
  });

  it("keeps manual cron cleanup progressing when task ledger updates fail", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);

      const updateTaskRecordSpy = vi
        .spyOn(taskExecutor, "finalizeTaskRunByRunIdCore")
        .mockImplementation(() => {
          throw new Error("disk full");
        });

      try {
        await expectDueIsolatedManualRunProgresses(storePath, now);
        expectWarnedJob({
          field: "jobStatus",
          value: "ok",
          message: "cron: failed to update task ledger record",
        });
      } finally {
        updateTaskRecordSpy.mockRestore();
      }
    });
  });

  it("non-schedule edit preserves nextRunAtMs (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const originalNextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "daily-report",
          name: "daily report",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "daily" },
          state: { nextRunAtMs: originalNextRunAtMs },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "daily-report", { description: "edited" });

    expect(updated.description).toBe("edited");
    expect(updated.state.nextRunAtMs).toBe(originalNextRunAtMs);
  });

  it("repairs nextRunAtMs=0 on non-schedule edit (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "broken-job",
          name: "broken",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
          state: { nextRunAtMs: 0 },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "broken-job", { description: "fixed" });

    expect(updated.description).toBe("fixed");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(0);
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("records startup catch-up timeouts as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createMissedIsolatedJob(now)],
      });

      const state = createTimedOutIsolatedCronState({
        storePath,
        now,
      });

      await runMissedJobs(state);

      expectTaskRun({
        runId: `cron:startup-timeout:${now}`,
        runtime: "cron",
        status: "timed_out",
        sourceId: "startup-timeout",
        progressSummary: "Running automation.",
      });
    });
  });

  it("seeds active manual cron task progress for status surfaces", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);
      let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(
          () =>
            new Promise<{ status: "ok"; summary: string }>((resolve) => {
              resolveRun = resolve;
            }),
        ),
      });

      const manualRun = run(state, "isolated-timeout");
      await vi.waitFor(() => {
        expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      });

      const task = findCronTaskByBaseRunId(`cron:isolated-timeout:${now}`);
      if (!task) {
        throw new Error("expected active manual cron task ledger record");
      }
      expect(task.status).toBe("running");
      expect(task.progressSummary).toBe("Running automation.");
      expect(formatTaskStatusDetail(task)).toBe("Running automation.");

      resolveRun?.({ status: "ok", summary: "done" });
      await manualRun;
    });
  });

  it("rejects add of a structurally valid cron expression that never matches", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    await expect(
      add(state, {
        name: "feb 30 cleanup",
        enabled: true,
        schedule: { kind: "cron", expr: "0 0 30 2 *" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "do work" },
      }),
    ).rejects.toThrow(/has no upcoming run time and would never fire/);
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs).toEqual([]);
  });

  it("accepts add of a satisfiable cron expression and arms a next run", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, {
      name: "daily cleanup",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("rejects update that changes a job to a never-matching cron expression", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, {
      name: "daily cleanup",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    await expect(
      update(state, job.id, { schedule: { kind: "cron", expr: "0 0 30 2 *" } }),
    ).rejects.toThrow(/has no upcoming run time and would never fire/);
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronStore(storePath);
    const stored = loaded.jobs.find((entry) => entry.id === job.id);
    expect(stored?.schedule).toMatchObject({ kind: "cron", expr: "0 0 * * *" });
  });

  it("allows non-schedule updates on a pre-existing never-matching job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "legacy-unsatisfiable",
          name: "legacy unsatisfiable",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "cron", expr: "0 0 30 2 *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "do work" },
          state: {},
        },
      ],
    });
    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "legacy-unsatisfiable", { enabled: false });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(updated.enabled).toBe(false);
  });

  it("clears auto-disable state and failure streaks when manually re-enabled", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-01T16:00:00.000Z");
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "auto-disabled-recurring",
          name: "auto-disabled recurring",
          enabled: false,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "cron", expr: "0 * * * *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "do work" },
          state: {
            consecutiveErrors: 10,
            scheduleErrorCount: 3,
            autoDisabled: {
              reason: "consecutive-failures",
              atMs: now - 1_000,
              consecutiveErrors: 10,
            },
          },
        },
      ],
    });
    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "auto-disabled-recurring", { enabled: true });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(updated).toMatchObject({
      enabled: true,
      state: { consecutiveErrors: 0, scheduleErrorCount: 0 },
    });
    expect(updated.state.autoDisabled).toBeUndefined();
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted).toMatchObject({
      enabled: true,
      state: { consecutiveErrors: 0, scheduleErrorCount: 0 },
    });
    expect(persisted?.state.autoDisabled).toBeUndefined();
  });

  it("rejects enabling a pre-existing never-matching job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "legacy-unsatisfiable",
          name: "legacy unsatisfiable",
          enabled: false,
          createdAtMs: now,
          updatedAtMs: now,
          schedule: { kind: "cron", expr: "0 0 30 2 *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "do work" },
          state: {},
        },
      ],
    });
    const state = createOkIsolatedCronState({ storePath, now });

    await expect(update(state, "legacy-unsatisfiable", { enabled: true })).rejects.toThrow(
      /has no upcoming run time and would never fire/,
    );

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.enabled).toBe(false);
  });

  it("uses the service clock when validating a finite-year cron update", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2000-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const job = await add(state, {
      name: "future finite-year job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const updated = await update(state, job.id, {
      schedule: { kind: "cron", expr: "0 0 0 1 1 * 2001", tz: "UTC" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(updated.state.nextRunAtMs).toBe(Date.parse("2001-01-01T00:00:00.000Z"));
  });

  it("accepts a finite-year cron while its final staggered run is pending", async () => {
    const { storePath } = await makeStorePath();
    const finalBaseRunAtMs = Date.parse("2001-01-01T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now: finalBaseRunAtMs + 1 });

    const job = await add(state, {
      name: "final staggered run",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 0 0 1 1 * 2001",
        tz: "UTC",
        staggerMs: 3_600_000,
      },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(job.state.nextRunAtMs).toBeGreaterThan(finalBaseRunAtMs);
  });

  it("uses explicit lifecycle events instead of scheduled duplicates for the target job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    const job = await add(state, {
      id: "lifecycle-target",
      name: "lifecycle target",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    expect(events.map((event) => event.action)).toEqual(["added"]);

    events.length = 0;
    await update(state, job.id, {
      schedule: { kind: "every", everyMs: 120_000, anchorMs: now },
    });
    expect(events.map((event) => event.action)).toEqual(["updated"]);

    events.length = 0;
    await remove(state, job.id);
    expect(events.map((event) => event.action)).toEqual(["removed"]);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("emits repaired sibling schedules during add before the target lifecycle event", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const sibling = createFutureEveryJob({ id: "repair-during-add", now });
    await writeCronStoreSnapshot({ storePath, jobs: [sibling] });
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    const added = await add(state, {
      id: "added-target",
      name: "added target",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "added" },
    });

    expect(events.map(({ jobId, action }) => ({ jobId, action }))).toEqual([
      { jobId: sibling.id, action: "scheduled" },
      { jobId: added.id, action: "added" },
    ]);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("emits repaired sibling schedules during remove before the target lifecycle event", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const sibling = createFutureEveryJob({ id: "repair-during-remove", now });
    const target = createFutureEveryJob({
      id: "removed-target",
      now,
      nextRunAtMs: now + 60_000,
    });
    await writeCronStoreSnapshot({ storePath, jobs: [sibling, target] });
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    await remove(state, target.id);

    expect(events.map(({ jobId, action }) => ({ jobId, action }))).toEqual([
      { jobId: sibling.id, action: "scheduled" },
      { jobId: target.id, action: "removed" },
    ]);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });
});

describe("cron service ops persist rollback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCreateInput(name: string) {
    return {
      name,
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    } as const;
  }

  it("does not persist, re-arm, or notify when removing a missing job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const onEvent = vi.fn();
    const state = createOkIsolatedCronState({ storePath, now, onEvent });
    const job = await add(state, makeCreateInput("daily cleanup"));
    const previousRevision = cronStoreModule.getCronJobsStoreRevision(storePath);
    const originalTimer = state.timer;
    onEvent.mockClear();
    const persist = vi.spyOn(cronStoreModule, "saveCronJobsStore");
    persist.mockClear();

    await expect(remove(state, "missing-job")).resolves.toEqual({ ok: true, removed: false });

    expect(persist).not.toHaveBeenCalled();
    expect(cronStoreModule.getCronJobsStoreRevision(storePath)).toBe(previousRevision);
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.timer).toBe(originalTimer);
    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
    expect((await loadCronStore(storePath)).jobs.map((entry) => entry.id)).toEqual([job.id]);

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(persist).toHaveBeenCalledOnce();
    expect(cronStoreModule.getCronJobsStoreRevision(storePath)).toBeGreaterThan(previousRevision);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, action: "removed" }),
    );
    expect((await loadCronStore(storePath)).jobs).toEqual([]);
  });

  it("rolls back an added job from the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(add(state, makeCreateInput("daily cleanup"))).rejects.toThrow("disk full");

    expect(state.timer).toBeNull();
    expect(state.store?.jobs ?? []).toEqual([]);
    const listed = await list(state, { includeDisabled: true });
    if (state.timer) {
      clearTimeout(state.timer);
    }
    expect(listed).toEqual([]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs).toEqual([]);
  });

  it("keeps the pre-update job in the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(update(state, job.id, { name: "renamed cleanup" })).rejects.toThrow("disk full");

    const inMemory = state.store?.jobs.find((entry) => entry.id === job.id);
    expect(inMemory?.name).toBe("daily cleanup");
    const loaded = await loadCronStore(storePath);
    const stored = loaded.jobs.find((entry) => entry.id === job.id);
    expect(stored?.name).toBe("daily cleanup");
  });

  it("does not clone the store before a missing or invalid update reaches commit", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const job = await add(state, makeCreateInput("daily cleanup"));
    const clone = vi.spyOn(globalThis, "structuredClone");

    await expect(update(state, "missing-job", { name: "missing" })).rejects.toThrow(
      "unknown cron job id",
    );
    await expect(
      update(state, job.id, { schedule: { kind: "cron", expr: "0 0 30 2 *" } }),
    ).rejects.toThrow(/no upcoming run time/);

    expect(clone).not.toHaveBeenCalledWith(state.store);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("keeps a removed job in the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(remove(state, job.id)).rejects.toThrow("disk full");

    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it("restores a job's catch-up deferral when a remove persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }
    job.state.startupCatchupAtMs = now + 5_000;

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(remove(state, job.id)).rejects.toThrow("disk full");

    expect(state.store?.jobs[0]?.state.startupCatchupAtMs).toBe(now + 5_000);
    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it("recovers after a failed persist so the next mutation succeeds", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));
    await expect(add(state, makeCreateInput("daily cleanup"))).rejects.toThrow("disk full");

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const listed = await list(state, { includeDisabled: true });
    if (state.timer) {
      clearTimeout(state.timer);
    }
    expect(listed.map((entry) => entry.id)).toEqual([job.id]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it.each(["mutation"] as const)(
    "notifies about schedule auto-disable only after %s persists",
    async (triggerPath) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-06-09T00:00:00.000Z");
      const state = createOkIsolatedCronState({ storePath, now });

      const malformed = await add(state, {
        ...makeCreateInput("malformed sibling"),
        schedule: { kind: "cron", expr: "0 1 * * *" },
      });
      if (state.timer) {
        clearTimeout(state.timer);
      }
      malformed.state.nextRunAtMs = undefined;
      malformed.state.scheduleErrorCount = 2;
      const enqueueSystemEvent = vi.mocked(state.deps.enqueueSystemEvent);
      const requestHeartbeat = vi.mocked(state.deps.requestHeartbeat);
      const order: string[] = [];
      enqueueSystemEvent.mockClear();
      requestHeartbeat.mockClear();
      enqueueSystemEvent.mockImplementation(() => {
        order.push("notify");
      });
      requestHeartbeat.mockImplementation(() => {
        order.push("heartbeat");
      });
      const computeNextRunAtMs = cronSchedule.computeNextRunAtMs;
      vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation((schedule, nowMs) => {
        if (schedule.kind === "cron" && schedule.expr === "0 1 * * *") {
          throw new Error("simulated schedule failure");
        }
        return computeNextRunAtMs(schedule, nowMs);
      });

      const saveCronJobsStore = cronStoreModule.saveCronJobsStore;
      vi.spyOn(cronStoreModule, "saveCronJobsStore")
        .mockRejectedValueOnce(new Error("disk full"))
        .mockImplementationOnce(async (...args) => {
          expect(enqueueSystemEvent).not.toHaveBeenCalled();
          expect(requestHeartbeat).not.toHaveBeenCalled();
          await saveCronJobsStore(...args);
          order.push("persist");
        });
      const trigger = () => add(state, makeCreateInput(`trigger ${triggerPath}`));
      await expect(trigger()).rejects.toThrow("disk full");

      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(true);
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();

      await trigger();
      if (state.timer) {
        clearTimeout(state.timer);
      }

      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
      expect(order).toEqual(["persist", "notify", "heartbeat"]);
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
      expect(requestHeartbeat).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["failed", "committed", "uncertain"] as const)(
    "publishes agent-removal auto-disable notifications only after a %s roster outcome",
    async (outcome) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-06-09T00:00:00.000Z");
      const state = createOkIsolatedCronState({ storePath, now });
      const removed = await add(state, {
        ...makeCreateInput("deleted agent job"),
        agentId: "doomed",
      });
      expect(
        writeCronJobScratch({
          storePath,
          jobId: removed.id,
          content: "deleted agent scratch",
          sourceSha256: "deleted-agent-source",
          nowMs: now - 1,
        }),
      ).toMatchObject({ ok: true, currentRevision: 1 });
      const scratchBefore = readCronJobScratchState(storePath, removed.id);
      const malformed = await add(state, {
        ...makeCreateInput("malformed surviving job"),
        agentId: "survivor",
        schedule: { kind: "cron", expr: "0 1 * * *" },
      });
      if (state.timer) {
        clearTimeout(state.timer);
      }
      malformed.state.nextRunAtMs = undefined;
      malformed.state.scheduleErrorCount = 2;
      const enqueueSystemEvent = vi.mocked(state.deps.enqueueSystemEvent);
      const requestHeartbeat = vi.mocked(state.deps.requestHeartbeat);
      enqueueSystemEvent.mockClear();
      requestHeartbeat.mockClear();
      const computeNextRunAtMs = cronSchedule.computeNextRunAtMs;
      vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation((schedule, nowMs) => {
        if (schedule.kind === "cron" && schedule.expr === "0 1 * * *") {
          throw new Error("simulated schedule failure");
        }
        return computeNextRunAtMs(schedule, nowMs);
      });

      const commit = vi.fn(async () => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
        const persisted = await loadCronStore(storePath);
        expect(persisted.jobs.find((job) => job.id === removed.id)).toBeUndefined();
        expect(persisted.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
        if (outcome === "failed") {
          throw new Error("roster commit failed");
        }
        if (outcome === "uncertain") {
          throw new AgentDeletionCommitUncertainError(new Error("roster commit uncertain"));
        }
        return "roster committed";
      });
      const transaction = removeAgentJobsTransactional(state, "doomed", commit);
      if (outcome === "committed") {
        await expect(transaction).resolves.toBe("roster committed");
      } else if (outcome === "uncertain") {
        await expect(transaction).rejects.toBeInstanceOf(AgentDeletionCommitUncertainError);
      } else {
        await expect(transaction).rejects.toThrow("roster commit failed");
      }
      if (state.timer) {
        clearTimeout(state.timer);
      }

      const rolledBack = outcome === "failed";
      const notificationCount = rolledBack ? 0 : 1;
      expect(commit).toHaveBeenCalledOnce();
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(notificationCount);
      expect(requestHeartbeat).toHaveBeenCalledTimes(notificationCount);
      expect(state.store?.jobs.some((job) => job.id === removed.id)).toBe(rolledBack);
      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(rolledBack);
      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs.some((job) => job.id === removed.id)).toBe(rolledBack);
      expect(persisted.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(rolledBack);
      expect(readCronJobScratchState(storePath, removed.id)).toEqual(
        rolledBack ? scratchBefore : { currentRevision: 0 },
      );
      if (!rolledBack) {
        const replacement = await add(state, {
          ...makeCreateInput("same-id replacement"),
          id: removed.id,
          agentId: "survivor",
        });
        expect(replacement.id).toBe(removed.id);
        expect(readCronJobScratchState(storePath, removed.id)).toEqual({ currentRevision: 0 });
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
    },
  );

  it("does not auto-disable a job during manual-run preflight", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const job = await add(state, {
      ...makeCreateInput("preflight schedule failure"),
      schedule: { kind: "cron", expr: "0 1 * * *" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }
    job.state.nextRunAtMs = undefined;
    job.state.scheduleErrorCount = 2;
    const before = structuredClone(job);
    const persistedBefore = structuredClone(
      (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id),
    );
    const enqueueSystemEvent = vi.mocked(state.deps.enqueueSystemEvent);
    const requestHeartbeat = vi.mocked(state.deps.requestHeartbeat);
    enqueueSystemEvent.mockClear();
    requestHeartbeat.mockClear();
    const computeSpy = vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation(() => {
      throw new Error("simulated preflight schedule failure");
    });

    try {
      await expect(inspectManualRunDisposition(state, job.id)).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "not-due",
      });
      expect(job).toEqual(before);
      expect((await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)).toEqual(
        persistedBefore,
      );
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      computeSpy.mockRestore();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
