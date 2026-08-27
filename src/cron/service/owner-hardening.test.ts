import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../../state/openclaw-state-db.paths.js";
import { advanceCronActiveJobGeneration, isCronJobActive } from "../active-jobs.js";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { upsertCronJobRow } from "../store/row-codec.js";
import {
  claimCronRunReceiptInDatabase,
  inspectActiveCronRunReceipt,
  isCronRunReceiptOwnerDefinitelyStale,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import { listForeignReceipts } from "./foreign-receipt-monitor.js";
import type { CronServiceState } from "./state.js";
import { findCronTaskRunRecoveryInDatabase } from "./task-runs.js";

const children = new Set<ChildProcess>();
let scriptRoot = "";
let runnerScript = "";

// Register this before the temp and store hooks because children can retain
// both filesystem and SQLite ownership until their exit event is observed.
afterEach(async () => {
  const activeChildren = [...children].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
  await Promise.all(activeChildren.map(waitForExit));
  children.clear();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-owner-hardening-" });

beforeEach(async () => {
  scriptRoot = tempDirs.make("cron-owner-hardening-script-", os.tmpdir());
  runnerScript = path.join(scriptRoot, "runner.mts");
  const serviceUrl = pathToFileURL(path.resolve("src/cron/service.ts")).href;
  const stateDatabaseUrl = pathToFileURL(path.resolve("src/state/openclaw-state-db.ts")).href;
  await fsPromises.writeFile(
    runnerScript,
    `
      import fs from "node:fs";
      import { CronService } from ${JSON.stringify(serviceUrl)};
      import { openOpenClawStateDatabase } from ${JSON.stringify(stateDatabaseUrl)};
      const [storePath, jobId, mode, releasePath, outputPath] = process.argv.slice(2);
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent() {
          if (mode === "manual-postcommit-crash") process.kill(process.pid, "SIGKILL");
        },
        requestHeartbeat() {},
        evaluateCronTrigger: async () => {
          process.stdout.write("trigger\\n");
          while (!fs.existsSync(releasePath)) await sleep(10);
          return { kind: "evaluated", fire: true };
        },
        runIsolatedAgentJob: async () => ({ status: "ok" }),
        runCommandJob: async ({ job }) => {
          if (mode === "manual-postcommit-crash") {
            return { status: "error", error: "expected manual failure" };
          }
          fs.appendFileSync(outputPath, job.agentId + ":" + process.pid + "\\n");
          process.stdout.write("started\\n");
          if (mode === "block" || mode === "barrier-block") await new Promise(() => {});
          if (mode === "hold") while (!fs.existsSync(releasePath)) await sleep(10);
          await sleep(150);
          return { status: "ok", summary: "done" };
        },
      });
      if (mode !== "manual-postcommit-crash") await cron.start();
      if (mode === "barrier-block") {
        process.stdout.write("ready\\n");
        while (!fs.existsSync(releasePath)) await sleep(10);
        await cron.run(jobId, "force");
      }
      if (mode === "crash-activation") {
        const database = openOpenClawStateDatabase().db;
        database.function("crash_activation", () => {
          process.kill(process.pid, "SIGKILL");
          return 0;
        });
        database.exec(\`
          CREATE TEMP TRIGGER crash_cron_activation
          BEFORE UPDATE OF state_json ON cron_jobs
          WHEN json_extract(OLD.state_json, '$.runningAtMs') IS NULL
            AND json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL
          BEGIN
            SELECT crash_activation();
          END;
        \`);
        await cron.run(jobId, "force");
      }
      if (mode === "manual-postcommit-crash") await cron.run(jobId, "due");
      if (mode === "block" || mode === "hold" || mode === "hold-alive") {
        await cron.run(jobId, "force");
      }
      if (mode === "hold-alive") {
        process.stdout.write("completed\\n");
        while (!fs.existsSync(releasePath + ".exit")) await sleep(10);
      }
      if (mode === "due") await sleep(350);
      cron.stop();
    `,
  );
});

function makeCommandJob(id: string, nextRunAtMs: number, trigger = false): CronJob {
  return {
    id,
    agentId: "alpha",
    name: id,
    enabled: true,
    createdAtMs: nextRunAtMs - 1,
    updatedAtMs: nextRunAtMs - 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    ...(trigger ? { trigger: { script: "return true" } } : {}),
    payload: { kind: "command", argv: ["true"] },
    state: { nextRunAtMs },
  };
}

function spawnRunner(params: {
  storePath: string;
  jobId: string;
  mode:
    | "barrier-block"
    | "block"
    | "hold"
    | "hold-alive"
    | "trigger"
    | "due"
    | "crash-activation"
    | "manual-postcommit-crash";
  releasePath: string;
  outputPath: string;
}): ChildProcess {
  const stateDir = resolveOpenClawStateDirForDatabasePath(openOpenClawStateDatabase().path);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      runnerScript,
      params.storePath,
      params.jobId,
      params.mode,
      params.releasePath,
      params.outputPath,
    ],
    {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  return child;
}

// Wait on the child protocol itself; cold TypeScript imports are not part of
// the cron ownership contract this fixture exercises.
async function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  let stdout = "";
  let stderr = "";
  let protocolFailure: Error | undefined;
  const onStderr = (chunk: unknown) => {
    stderr += String(chunk);
  };
  if (!child.stdout) {
    throw new Error(`cron child has no stdout while waiting for ${expected}`);
  }
  const failure = (reason: string, cause?: Error) =>
    new Error(`cron child ${reason} before ${expected}: ${stderr || stdout}`, { cause });
  const onExit = () => {
    protocolFailure = failure("exited");
    child.stdout?.destroy(protocolFailure);
  };
  const onChildError = (error: Error) => {
    protocolFailure = failure("failed", error);
    child.stdout?.destroy(protocolFailure);
  };
  const onStdoutClose = () => {
    protocolFailure ??= failure("closed stdout");
  };
  const onStdoutError = (error: Error) => {
    protocolFailure ??= failure("failed to read stdout", error);
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    throw failure("exited");
  }
  child.stderr?.on("data", onStderr);
  child.once("exit", onExit);
  child.once("error", onChildError);
  child.stdout.once("close", onStdoutClose);
  child.stdout.once("error", onStdoutError);
  try {
    for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
      stdout += String(chunk);
      if (stdout.split("\n").includes(expected)) {
        return;
      }
    }
    throw protocolFailure ?? failure("closed stdout");
  } catch (error) {
    throw protocolFailure ?? error;
  } finally {
    child.stderr?.off("data", onStderr);
    child.off("exit", onExit);
    child.off("error", onChildError);
    child.stdout.off("close", onStdoutClose);
    child.stdout.off("error", onStdoutError);
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function waitForImmediate(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function makeParentService(storePath: string, runCommandJob = vi.fn()) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runCommandJob,
  });
}

function receipts(storePath: string, jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      `SELECT receipt_id AS receiptId, status, agent_id AS agentId,
              started_at_ms AS startedAtMs
         FROM cron_run_receipts
        WHERE store_key = ? AND job_id = ?
        ORDER BY started_at_ms DESC, receipt_id DESC`,
    )
    .all(cronStoreKey(storePath), jobId) as Array<{
    receiptId: string;
    status: string;
    agentId: string;
    startedAtMs: number;
  }>;
}

function databaseUpdateReceiptToRunning(receiptId: string): void {
  openOpenClawStateDatabase()
    .db.prepare(
      `UPDATE cron_run_receipts
          SET status = 'running', finished_at_ms = NULL, error_text = NULL
        WHERE receipt_id = ?`,
    )
    .run(receiptId);
}

function claimMarkerlessReceipt(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId!,
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId!,
    }),
  );
}

describe("cron durable run ownership", () => {
  it("does not execute when the durable receipt cannot be recorded", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("receipt-required", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_cron_run_receipt
      BEFORE INSERT ON cron_run_receipts
      BEGIN
        SELECT RAISE(ABORT, 'receipt unavailable');
      END;
    `);
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const cron = makeParentService(storePath, runner);
    try {
      await expect(cron.run(job.id, "force")).rejects.toThrow("receipt unavailable");
      expect(runner).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      database.exec("DROP TRIGGER IF EXISTS reject_cron_run_receipt");
    }
  });

  it("rolls back the receipt with the running marker when activation crashes", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("atomic-activation-crash", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const outputPath = path.join(scriptRoot, `activation-output-${now}`);
    const child = spawnRunner({
      storePath,
      jobId: job.id,
      mode: "crash-activation",
      releasePath: path.join(scriptRoot, `unused-release-${now}`),
      outputPath,
    });

    await waitForExit(child);
    expect(child.signalCode).toBe("SIGKILL");
    expect(fs.existsSync(outputPath)).toBe(false);

    const recovered = makeParentService(storePath);
    try {
      await recovered.start();
      expect(receipts(storePath, job.id)).toMatchObject([{ status: "interrupted" }]);
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
    } finally {
      recovered.stop();
    }
  });

  it("retries transient receipt finalization before releasing ownership", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("receipt-finalization-failure", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_cron_run_receipt_finish
      BEFORE UPDATE OF status ON cron_run_receipts
      WHEN OLD.status = 'running' AND NEW.status != 'running'
      BEGIN
        SELECT RAISE(ABORT, 'receipt finalization unavailable');
      END;
    `);
    const cron = makeParentService(
      storePath,
      vi.fn(async () => {
        advanceCronActiveJobGeneration();
        return { status: "ok" as const };
      }),
    );
    try {
      await expect(cron.run(job.id, "force")).rejects.toThrow("receipt finalization unavailable");
      expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "running" });
      database.exec("DROP TRIGGER reject_cron_run_receipt_finish");
      await vi.waitFor(
        () => expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "superseded" }),
        { timeout: 3_000, interval: 50 },
      );
    } finally {
      cron.stop();
      database.exec("DROP TRIGGER IF EXISTS reject_cron_run_receipt_finish");
    }
    expect(isCronJobActive(job.id)).toBe(false);

    const replacement = makeParentService(
      storePath,
      vi.fn(async () => ({ status: "ok" as const })),
    );
    try {
      await replacement.start();
      await expect(replacement.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    } finally {
      replacement.stop();
    }
  });

  it("releases process-local receipt ownership after a successful manual run", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("successful-manual-release", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const cron = makeParentService(
      storePath,
      vi.fn(async () => ({ status: "ok" as const })),
    );
    try {
      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      const receipt = receipts(storePath, job.id)[0];
      expect(receipt).toMatchObject({ status: "ok" });
      databaseUpdateReceiptToRunning(receipt!.receiptId);

      const active = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      expect(active?.receiptId).toBe(receipt!.receiptId);
      expect(isCronRunReceiptOwnerDefinitelyStale(active!)).toBe(true);
    } finally {
      cron.stop();
    }
  });

  it("recovers owner death after a post-startup admission conflict", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("restart-mid-run", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const replacementRunner = vi.fn(async () => ({ status: "ok" as const }));
    const replacement = makeParentService(storePath, replacementRunner);
    let owner: ChildProcess | undefined;
    try {
      await replacement.start();
      owner = spawnRunner({
        storePath,
        jobId: job.id,
        mode: "block",
        releasePath: path.join(scriptRoot, `release-${now}`),
        outputPath: path.join(scriptRoot, `output-${now}`),
      });
      await waitForLine(owner, "started");
      await expect(replacement.run(job.id, "force")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "already-running",
      });
      expect(replacementRunner).not.toHaveBeenCalled();
      expect(receipts(storePath, job.id)).toMatchObject([{ status: "running" }]);

      owner.kill("SIGKILL");
      await waitForExit(owner);
      await vi.waitFor(
        async () => {
          expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "interrupted" });
          const recoveredState = (await loadCronStore(storePath)).jobs[0]?.state;
          expect(recoveredState?.lastError).toContain("interrupted by gateway restart");
          expect(recoveredState?.nextRunAtMs).toEqual(expect.any(Number));
        },
        { timeout: 6_000, interval: 50 },
      );

      await expect(replacement.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(replacementRunner).toHaveBeenCalledOnce();
    } finally {
      replacement.stop();
      if (owner && owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
      }
    }
  });

  it("re-arms foreign completion and schedules an unrelated imported job", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("foreign-normal-completion", now + 60_000);
    job.schedule = { kind: "every", everyMs: 3_000, anchorMs: now };
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const releasePath = path.join(scriptRoot, `normal-release-${now}`);
    const outputPath = path.join(scriptRoot, `normal-output-${now}`);
    const owner = spawnRunner({
      storePath,
      jobId: job.id,
      mode: "hold-alive",
      releasePath,
      outputPath,
    });
    await waitForLine(owner, "started");
    const database = openOpenClawStateDatabase().db;
    const unrelated = makeCommandJob("imported-during-foreign-run", now + 60_000);
    unrelated.state = {};
    upsertCronJobRow(database, cronStoreKey(storePath), unrelated, 1);
    database
      .prepare(
        "UPDATE cron_jobs SET state_json = json_remove(state_json, '$.nextRunAtMs') WHERE job_id = ?",
      )
      .run(job.id);

    const replacement = makeParentService(storePath);
    try {
      await replacement.start();
      const replacementState = (replacement as unknown as { state: CronServiceState }).state;
      const staleTimer = replacementState.timer;
      const completed = waitForLine(owner, "completed");
      await fsPromises.writeFile(releasePath, "release");
      await completed;
      await vi.waitFor(
        async () => {
          expect(replacementState.timer).not.toBe(staleTimer);
          const persisted = await loadCronStore(storePath);
          expect(persisted.jobs.find((entry) => entry.id === job.id)?.state.nextRunAtMs).toEqual(
            expect.any(Number),
          );
          expect(
            persisted.jobs.find((entry) => entry.id === unrelated.id)?.state.nextRunAtMs,
          ).toEqual(expect.any(Number));
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      replacement.stop();
      await fsPromises.writeFile(`${releasePath}.exit`, "exit");
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
      }
    }
  });

  it("settles existing foreign receipts while suspension keeps unrelated cron work fenced", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("foreign-marker-handoff", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const first = spawnRunner({
      storePath,
      jobId: job.id,
      mode: "block",
      releasePath: path.join(scriptRoot, `first-release-${now}`),
      outputPath: path.join(scriptRoot, `first-output-${now}`),
    });
    await waitForLine(first, "started");

    const replacementRunner = vi.fn(async () => ({ status: "ok" as const }));
    const replacement = makeParentService(storePath, replacementRunner);
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> | undefined;
    let second: ChildProcess | undefined;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await replacement.start();
      const replacementState = (replacement as unknown as { state: CronServiceState }).state;
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      replacement.pauseScheduling();
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      expect(replacementState.timer).toBeNull();
      first.kill("SIGKILL");
      await waitForExit(first);
      second = spawnRunner({
        storePath,
        jobId: job.id,
        mode: "block",
        releasePath: path.join(scriptRoot, `second-release-${now}`),
        outputPath: path.join(scriptRoot, `second-output-${now}`),
      });
      await waitForLine(second, "started");
      const secondReceiptId = receipts(storePath, job.id)[0]?.receiptId;
      expect(secondReceiptId).toBeDefined();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitForImmediate(
        () => listForeignReceipts(replacementState)[0]?.receiptId === secondReceiptId,
        "replacement foreign receipt enrollment",
      );
      second.kill("SIGKILL");
      await waitForExit(second);
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(
        async () => {
          expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "interrupted" });
          expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBeUndefined();
        },
        { timeout: 1_000, interval: 10 },
      );
      expect(replacementState.schedulingPaused).toBe(true);
      expect(replacementState.timer).toBeNull();
      expect(replacementRunner).not.toHaveBeenCalled();
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    } finally {
      suspension?.release();
      replacement.stop();
      vi.useRealTimers();
      for (const child of [first, second]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
    }
  });

  it("admits one payload across overlapping scheduler processes", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("overlapping-ticks", now - 1);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const releasePath = path.join(scriptRoot, `barrier-${now}`);
    const outputPath = path.join(scriptRoot, `ticks-${now}`);
    const first = spawnRunner({ storePath, jobId: job.id, mode: "due", releasePath, outputPath });
    const second = spawnRunner({ storePath, jobId: job.id, mode: "due", releasePath, outputPath });
    await Promise.all([waitForExit(first), waitForExit(second)]);

    const invocations = fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(invocations).toHaveLength(1);
    expect(receipts(storePath, job.id)).toMatchObject([{ status: "ok" }]);
  });

  it("preserves different jobs activated concurrently by two gateways", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const firstJob = makeCommandJob("gateway-a-job", now + 60_000);
    const secondJob = makeCommandJob("gateway-b-job", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [firstJob, secondJob] });
    const firstBarrier = path.join(scriptRoot, `gateway-a-barrier-${now}`);
    const secondBarrier = path.join(scriptRoot, `gateway-b-barrier-${now}`);
    const first = spawnRunner({
      storePath,
      jobId: firstJob.id,
      mode: "barrier-block",
      releasePath: firstBarrier,
      outputPath: path.join(scriptRoot, `gateway-a-output-${now}`),
    });
    const second = spawnRunner({
      storePath,
      jobId: secondJob.id,
      mode: "barrier-block",
      releasePath: secondBarrier,
      outputPath: path.join(scriptRoot, `gateway-b-output-${now}`),
    });
    try {
      await Promise.all([waitForLine(first, "ready"), waitForLine(second, "ready")]);
      const firstStarted = waitForLine(first, "started");
      const secondStarted = waitForLine(second, "started");
      await Promise.all([
        fsPromises.writeFile(firstBarrier, "start"),
        fsPromises.writeFile(secondBarrier, "start"),
      ]);
      await Promise.all([firstStarted, secondStarted]);

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs.find((job) => job.id === firstJob.id)?.state.runningAtMs).toEqual(
        expect.any(Number),
      );
      expect(persisted.jobs.find((job) => job.id === secondJob.id)?.state.runningAtMs).toEqual(
        expect.any(Number),
      );
      expect(receipts(storePath, firstJob.id)[0]).toMatchObject({ status: "running" });
      expect(receipts(storePath, secondJob.id)[0]).toMatchObject({ status: "running" });
    } finally {
      for (const child of [first, second]) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
    }
  });

  it("fences an owner change for the full admitted-run lease", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("owner-change-live", now - 1, true);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const releasePath = path.join(scriptRoot, `owner-release-${now}`);
    const outputPath = path.join(scriptRoot, `owner-output-${now}`);
    const owner = spawnRunner({
      storePath,
      jobId: job.id,
      mode: "trigger",
      releasePath,
      outputPath,
    });
    await waitForLine(owner, "trigger");

    const editor = makeParentService(storePath);
    try {
      await expect(editor.update(job.id, { agentId: "beta" })).rejects.toThrow("already running");
      await fsPromises.writeFile(releasePath, "release");
      await waitForExit(owner);

      expect(fs.readFileSync(outputPath, "utf8")).toMatch(/^alpha:\d+\n$/);
      expect(receipts(storePath, job.id)[0]).toMatchObject({
        agentId: "alpha",
        status: "ok",
      });
      await expect(editor.update(job.id, { agentId: "beta" })).resolves.toMatchObject({
        agentId: "beta",
      });
    } finally {
      editor.stop();
    }
  });

  it("permits an owner change after a markerless receipt owner dies", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("owner-change-dead", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const abandoned = claimMarkerlessReceipt(storePath, job, now);
    releaseLocalCronRunReceiptOwnership(abandoned);

    const editor = makeParentService(storePath);
    try {
      await expect(editor.update(job.id, { agentId: "beta" })).resolves.toMatchObject({
        agentId: "beta",
      });
      expect(receipts(storePath, job.id)).toMatchObject([
        { receiptId: abandoned.receiptId, status: "interrupted", agentId: "alpha" },
      ]);
    } finally {
      editor.stop();
    }
  });

  it("force-runs through a dead markerless receipt without lifecycle startup", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("force-after-dead-owner", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const abandoned = claimMarkerlessReceipt(storePath, job, now);
    releaseLocalCronRunReceiptOwnership(abandoned);
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const cron = makeParentService(storePath, runner);
    try {
      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runner).toHaveBeenCalledOnce();
      expect(
        receipts(storePath, job.id)
          .map(({ status }) => status)
          .toSorted(),
      ).toEqual(["interrupted", "ok"]);
    } finally {
      cron.stop();
    }
  });

  it("records manual task recovery before postcommit notification can crash", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("manual-task-precommit", now - 1);
    job.state.consecutiveErrors = 9;
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const child = spawnRunner({
      storePath,
      jobId: job.id,
      mode: "manual-postcommit-crash",
      releasePath: path.join(scriptRoot, `unused-release-${now}`),
      outputPath: path.join(scriptRoot, `unused-output-${now}`),
    });

    await waitForExit(child);

    expect(child.signalCode).toBe("SIGKILL");
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state).toMatchObject({
      lastRunStatus: "error",
      consecutiveErrors: 10,
    });
    expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "error" });
    const recovered = findCronTaskRunRecoveryInDatabase({
      database: openOpenClawStateDatabase().db,
      jobId: job.id,
      startedAt: persisted!.state.lastRunAtMs!,
      storeKey: cronStoreKey(storePath),
    });
    expect(recovered.finalized?.entry).toMatchObject({
      jobId: job.id,
      status: "error",
    });
  });
});
