import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../../state/openclaw-state-db.paths.js";
import { advanceCronActiveJobGeneration, isCronJobActive } from "../active-jobs.js";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { reconcileCronRunReceiptForStartup } from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-owner-hardening-" });
const children = new Set<ChildProcess>();
let scriptRoot = "";
let runnerScript = "";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
        enqueueSystemEvent() {},
        requestHeartbeat() {},
        evaluateCronTrigger: async () => {
          process.stdout.write("trigger\\n");
          while (!fs.existsSync(releasePath)) await sleep(10);
          return { kind: "evaluated", fire: true };
        },
        runIsolatedAgentJob: async () => ({ status: "ok" }),
        runCommandJob: async ({ job }) => {
          fs.appendFileSync(outputPath, job.agentId + ":" + process.pid + "\\n");
          process.stdout.write("started\\n");
          if (mode === "block") await new Promise(() => {});
          await sleep(150);
          return { status: "ok", summary: "done" };
        },
      });
      await cron.start();
      if (mode === "crash-activation") {
        const database = openOpenClawStateDatabase().db;
        database.function("crash_activation", () => {
          process.kill(process.pid, "SIGKILL");
          return 0;
        });
        database.exec(\`
          CREATE TEMP TRIGGER crash_cron_activation
          BEFORE UPDATE OF running_at_ms ON cron_jobs
          WHEN OLD.running_at_ms IS NULL AND NEW.running_at_ms IS NOT NULL
          BEGIN
            SELECT crash_activation();
          END;
        \`);
        await cron.run(jobId, "force");
      }
      if (mode === "block") await cron.run(jobId, "force");
      if (mode === "due") await sleep(350);
      cron.stop();
    `,
  );
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.clear();
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
  mode: "block" | "trigger" | "due" | "crash-activation";
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

async function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await vi.waitFor(
    () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`cron child exited before ${expected}: ${stderr || stdout}`);
      }
      expect(stdout.split("\n")).toContain(expected);
    },
    { timeout: 10_000, interval: 20 },
  );
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

describe("cron durable run ownership", () => {
  it("does not execute when the durable receipt cannot be recorded", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("receipt-required", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    reconcileCronRunReceiptForStartup({
      storePath,
      jobId: job.id,
      startedAtMs: 0,
      nowMs: now,
    });
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
      expect(receipts(storePath, job.id)).toEqual([]);
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
    } finally {
      recovered.stop();
    }
  });

  it("releases manual run ownership when receipt finalization throws", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("receipt-finalization-failure", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    reconcileCronRunReceiptForStartup({
      storePath,
      jobId: job.id,
      startedAtMs: 0,
      nowMs: now,
    });
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

      expect(
        reconcileCronRunReceiptForStartup({
          storePath,
          jobId: job.id,
          startedAtMs: receipt!.startedAtMs,
          nowMs: now + 1,
        }),
      ).toBeUndefined();
      expect(receipts(storePath, job.id)[0]).toMatchObject({ status: "interrupted" });
    } finally {
      cron.stop();
    }
  });

  it("recovers a foreign run whose owner dies after overlapping startup", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("restart-mid-run", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const releasePath = path.join(scriptRoot, `release-${now}`);
    const outputPath = path.join(scriptRoot, `output-${now}`);
    const owner = spawnRunner({ storePath, jobId: job.id, mode: "block", releasePath, outputPath });
    await waitForLine(owner, "started");

    const replacementRunner = vi.fn(async () => ({ status: "ok" as const }));
    const replacement = makeParentService(storePath, replacementRunner);
    try {
      await replacement.start();
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
          expect((await loadCronStore(storePath)).jobs[0]?.state.lastError).toContain(
            "interrupted by gateway restart",
          );
        },
        { timeout: 6_000, interval: 50 },
      );

      await expect(replacement.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(replacementRunner).toHaveBeenCalledOnce();
    } finally {
      replacement.stop();
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
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
});
