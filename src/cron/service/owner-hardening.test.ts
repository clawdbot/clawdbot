import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../../state/openclaw-state-db.paths.js";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { listCronRunReceipts } from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-owner-hardening-" });
const children = new Set<ChildProcess>();
let scriptRoot = "";
let runnerScript = "";

beforeAll(async () => {
  scriptRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cron-owner-hardening-script-"));
  runnerScript = path.join(scriptRoot, "runner.mts");
  const serviceUrl = pathToFileURL(path.resolve("src/cron/service.ts")).href;
  await fsPromises.writeFile(
    runnerScript,
    `
      import fs from "node:fs";
      import { CronService } from ${JSON.stringify(serviceUrl)};
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
        runCommandJob: async () => {
          fs.appendFileSync(outputPath, process.pid + "\\n");
          process.stdout.write("started\\n");
          if (mode === "block") await new Promise(() => {});
          await sleep(150);
          return { status: "ok", summary: "done" };
        },
      });
      await cron.start();
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
  mode: "block" | "trigger" | "due";
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

describe("cron durable run ownership", () => {
  it("does not execute when the durable receipt cannot be recorded", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = makeCommandJob("receipt-required", now + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    listCronRunReceipts(storePath, job.id);
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

  it("keeps a live run fenced across an overlapping gateway start", async () => {
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
    await replacement.start();
    await expect(replacement.run(job.id, "force")).resolves.toEqual({
      ok: true,
      ran: false,
      reason: "already-running",
    });
    expect(replacementRunner).not.toHaveBeenCalled();
    expect(listCronRunReceipts(storePath, job.id)).toMatchObject([{ status: "running" }]);
    replacement.stop();

    owner.kill("SIGKILL");
    await waitForExit(owner);
    const recovered = makeParentService(storePath);
    await recovered.start();
    recovered.stop();

    expect(listCronRunReceipts(storePath, job.id)[0]).toMatchObject({ status: "interrupted" });
    expect((await loadCronStore(storePath)).jobs[0]?.state.lastError).toContain(
      "interrupted by gateway restart",
    );
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
    expect(listCronRunReceipts(storePath, job.id)).toMatchObject([{ status: "ok" }]);
  });

  it("supersedes a live run before payload effects after its owner changes", async () => {
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
    await editor.update(job.id, { agentId: "beta" });
    editor.stop();
    await fsPromises.writeFile(releasePath, "release");
    await waitForExit(owner);

    expect(fs.existsSync(outputPath)).toBe(false);
    expect(listCronRunReceipts(storePath, job.id)[0]).toMatchObject({
      agentId: "alpha",
      status: "superseded",
    });
    const current = (await loadCronStore(storePath)).jobs[0];
    expect(current?.agentId).toBe("beta");
    expect(current?.state.lastRunAtMs).toBeUndefined();
  });
});
